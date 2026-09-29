/**
 * Langfuse AI-tracing for the credix Mastra instance.
 *
 * This is the Mastra-native observability path (@mastra/observability + @mastra/langfuse), separate
 * from the OpenTelemetry SDK in tracing.ts: OTel keeps the HTTP/infra view in Honeycomb, while this
 * gives the LLM-native agent/workflow/tool/generation view in Langfuse (model + tokens + Agent Graph).
 *
 * Gating: mirrors tracing.ts's OTLP gate. All THREE of LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY and
 * LANGFUSE_BASE_URL must be set; otherwise the whole config is omitted, so nothing is constructed and
 * NO data (or PII) leaves the process. The base URL is part of the gate on purpose: the Langfuse SDK
 * defaults to the public https://cloud.langfuse.com when it is unset, so a missing URL would silently
 * ship financial PII to a third-party endpoint (PR #19 review). Requiring it makes the destination an
 * explicit deployment decision: self-hosted, or a compliance-tier Langfuse instance we have signed off.
 *
 * PII: this service must never export raw mobile / PAN / Aadhaar / email. Three mechanisms run before
 * export, in order of bluntness:
 *   1. SensitiveDataFilter — Mastra's built-in, redacts by FIELD NAME (apiKey, token, ...).
 *   2. identifierScrubProcessor — redacts by VALUE via the shared scrubIdentifiers regex, catching
 *      identifiers embedded in free text (prompts, tool I/O, the masked-profile JSON) that name-based
 *      filtering cannot see. This is the same redaction the OTel I/O capture uses (lib/otel.ts).
 *   3. OMITTED_INPUT_KEYS — whole payloads dropped from span input. Patterns cannot help with bulk
 *      financial data (no identifier to match), so the raw bureau profile and the signals payload are
 *      removed by key rather than scrubbed (PR #19 review).
 * user_id (a mobile number) IS mapped to the Langfuse user id, by explicit decision on 2026-07-30
 * (the alternative offered was an HMAC hash). server.ts passes it as trace metadata; the scrub
 * processor below exempts that one field. Every other appearance of a mobile is still redacted.
 */
import { Observability, SensitiveDataFilter } from '@mastra/observability'
import { LangfuseExporter } from '@mastra/langfuse'
import type { AnySpan, SpanOutputProcessor } from '@mastra/core/observability'
import { scrubIdentifiers } from './otel'

/** Recursively run scrubIdentifiers over every string in a value, preserving structure. */
function deepScrub(value: unknown): unknown {
  if (typeof value === 'string') return scrubIdentifiers(value)
  if (Array.isArray(value)) return value.map(deepScrub)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = deepScrub(v)
    return out
  }
  return value
}

/**
 * Whole payloads dropped from span input before export, by key.
 *
 * The workflow root span's input IS the workflow input, so it carries the RAW sidecar
 * `bureau_profile` (identity fields plus every loan, enquiry and DPD row) and the `signals` payload
 * (exact age, income estimates). Pattern scrubbing cannot help here: scrubIdentifiers matches
 * identifiers, and this is bulk financial data with no pattern to match (PR #19 review). Dropping the
 * keys leaves the parts of trace input that observability actually needs — the message, session and
 * channel — so the trace list stays readable.
 *
 * These are the names as they appear in the workflow input. Bureau data reached through a TOOL is not
 * covered, because a section response has no wrapping key; see the follow-up in tasks/improvements.txt.
 */
const OMITTED_KEYS = new Set(['bureau_profile', 'masked_profile', 'signals'])
const OMITTED = '[omitted: financial payload, not exported]'

/** Recursive on purpose: the same payload rides nested inside step-span and memory-processor inputs
 *  (`{ inputData: { bureau_profile } }`), so a top-level-only pass left most copies in place. */
function omitHeavyPayloads(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(omitHeavyPayloads)
  if (value === null || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = OMITTED_KEYS.has(k) ? OMITTED : omitHeavyPayloads(v)
  }
  return out
}

// Value-based identifier redaction: complements the name-based SensitiveDataFilter. Scrubs the span
// fields that carry free text (input/output/metadata) plus the agent-run prompt/instructions
// attributes, where the masked profile and user message land.
export const identifierScrubProcessor: SpanOutputProcessor = {
  name: 'credix-identifier-scrub',
  process(span?: AnySpan): AnySpan | undefined {
    if (!span) return span
    if (span.input !== undefined) span.input = deepScrub(omitHeavyPayloads(span.input))
    if (span.output !== undefined) span.output = deepScrub(omitHeavyPayloads(span.output))
    if (span.metadata) {
      // `userId` carries the raw mobile by explicit product decision (2026-07-30) so Langfuse's
      // per-user view works. It is exempt from the value scrub, which would otherwise rewrite every
      // user to the same `[REDACTED]` id and collapse the whole per-user view into one bucket.
      // Everything else in metadata still goes through scrubIdentifiers.
      const userId = span.metadata.userId
      span.metadata = deepScrub(span.metadata) as Record<string, unknown>
      if (userId !== undefined) span.metadata.userId = userId
    }
    const attrs = span.attributes as Record<string, unknown> | undefined
    if (attrs) {
      if (typeof attrs.prompt === 'string') attrs.prompt = scrubIdentifiers(attrs.prompt)
      if (typeof attrs.instructions === 'string') attrs.instructions = scrubIdentifiers(attrs.instructions)
    }
    return span
  },
  async shutdown() {},
}

/**
 * Build the Langfuse observability registry, or return undefined when unconfigured (missing key or
 * base URL) so the Mastra instance runs exactly as before with tracing off. realtime in development
 * flushes each event for the debug loop; production batches.
 */
export function buildObservability(): Observability | undefined {
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY
  const secretKey = process.env.LANGFUSE_SECRET_KEY
  // baseUrl is part of the gate, not an option: unset, the Langfuse SDK falls back to the public
  // cloud.langfuse.com, and the trace-level userId is a raw mobile. No URL, no export.
  const baseUrl = process.env.LANGFUSE_BASE_URL
  if (!publicKey || !secretKey) return undefined
  // Keys WITH no destination is the one combination worth a warning: it looks configured, so a silent
  // return would read as "Langfuse is broken" rather than "you never named an instance".
  if (!baseUrl) {
    console.warn(
      '[observability] LANGFUSE_PUBLIC_KEY/SECRET_KEY are set but LANGFUSE_BASE_URL is not; ' +
        'tracing stays OFF (refusing to default to the public cloud host while PII is in scope)',
    )
    return undefined
  }

  return new Observability({
    configs: {
      langfuse: {
        serviceName: process.env.OTEL_SERVICE_NAME ?? 'credix-mastra',
        exporters: [
          new LangfuseExporter({
            publicKey,
            secretKey,
            baseUrl, // gated above: self-hosted or compliance-tier only
            environment: process.env.NODE_ENV,
            realtime: process.env.NODE_ENV === 'development',
          }),
        ],
        spanOutputProcessors: [new SensitiveDataFilter(), identifierScrubProcessor],
      },
    },
  })
}
