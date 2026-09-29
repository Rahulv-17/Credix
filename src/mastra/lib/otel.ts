/**
 * Tiny custom-instrumentation helpers shared by the workflow steps and the server.
 *
 * Importing this is safe everywhere, including under `bun test`: when the OTel SDK has not been
 * started (tests never load tracing.ts), `trace.getTracer()` returns a no-op tracer, so
 * `startActiveSpan` simply runs the callback with a non-recording span and `setAttribute` is a
 * no-op. Custom spans therefore add zero behaviour in tests.
 *
 * PII rule for this service: span attributes must NEVER carry hard identifiers — user_id / mobile,
 * PAN, or Aadhaar. Stage input/output capture (below) is OFF by default and, even when enabled,
 * runs every payload through `scrubIdentifiers` so those identifiers can never reach Honeycomb.
 * CIBIL scores are intentionally NOT scrubbed (see patterns.ts): they are 3-digit values a blanket
 * redaction cannot tell apart from ordinary numbers, so when capture is on they may appear alongside
 * other masked financials. Keep capture off in production.
 */
import { trace, SpanStatusCode, type Span } from '@opentelemetry/api'
import { AADHAAR_PATTERN, EMAIL_PATTERN, MOBILE_PATTERN, PAN_PATTERN } from './patterns'

export const tracer = trace.getTracer('credix-mastra')

/** Tag a span with a static, greppable error slug and mark it failed. */
export function recordError(span: Span, err: unknown, slug: string): void {
  span.setAttribute('exception.slug', slug)
  span.setAttribute('error', true)
  // Scrub identifiers before recording: recordException writes exception.message/stacktrace to the
  // span, and a thrown error can echo user input (e.g. a validation message). Same PII rule as I/O
  // capture above; the stack's first line repeats the message, so scrub it too.
  const e = err instanceof Error ? err : new Error(String(err))
  span.recordException({
    name: e.name,
    message: scrubIdentifiers(e.message),
    stack: e.stack ? scrubIdentifiers(e.stack) : undefined,
  })
  span.setStatus({ code: SpanStatusCode.ERROR })
}

// ── Stage input/output capture (opt-in, identifier-scrubbed) ──────────────────
//
// Enabled by OTEL_CAPTURE_IO=1 (or =true). OFF in production by default. When on, each stage span
// gets `app.io.input` / `app.io.output` so the full flow is inspectable in Honeycomb — but every
// payload is run through scrubIdentifiers (PAN / Aadhaar / mobile -> [REDACTED]), tts audio blobs are
// compressed, and the result is truncated. Messages, intents, responses, and masked financials stay
// visible; hard identifiers never leave.
export const CAPTURE_IO =
  process.env.OTEL_CAPTURE_IO === '1' || process.env.OTEL_CAPTURE_IO === 'true'

const MAX_IO_CHARS = 8192

/** Redact base64 data URIs (e.g. the tts audio blob) down to a byte-count marker. */
function compressDataUri(s: string): string {
  return s.replace(
    /(data:[^;]+;base64,)[A-Za-z0-9+/=]{64,}/g,
    (m, prefix: string) => `${prefix}<${m.length - prefix.length} b64 chars>`,
  )
}

/** Strip hard identifiers regardless of capture mode — defense in depth before anything leaves.
 *  Exported so outbound-to-third-party paths (e.g. Exa web grounding) can reuse the same redaction. */
export function scrubIdentifiers(s: string): string {
  // Aadhaar (12 digits) before mobile (10 digits) so a partial Aadhaar is not split into mobiles.
  // Email BEFORE the digit patterns: an address can contain a 10-digit local part (9886429660@x.com),
  // and redacting the digits first would leave a half-scrubbed address behind (PR #19 review).
  return s
    .replace(new RegExp(EMAIL_PATTERN.source, 'g'), '[REDACTED]')
    .replace(new RegExp(AADHAAR_PATTERN.source, 'g'), '[REDACTED]')
    .replace(new RegExp(PAN_PATTERN.source, 'g'), '[REDACTED]')
    .replace(new RegExp(MOBILE_PATTERN.source, 'g'), '[REDACTED]')
}

/** Stringify a stage payload PII-safely: compress audio blobs, scrub identifiers, truncate. */
export function safeStringify(value: unknown, cap = MAX_IO_CHARS): string {
  let s: string
  try {
    s = typeof value === 'string' ? value : JSON.stringify(value) ?? ''
  } catch {
    s = String(value)
  }
  s = scrubIdentifiers(compressDataUri(s))
  return s.length > cap ? `${s.slice(0, cap)}…[+${s.length - cap} chars]` : s
}

export function captureInput(span: Span, value: unknown): void {
  if (CAPTURE_IO) span.setAttribute('app.io.input', safeStringify(value))
}

export function captureOutput(span: Span, value: unknown): void {
  if (CAPTURE_IO) span.setAttribute('app.io.output', safeStringify(value))
}

/**
 * Wrap a workflow stage's work in a `stage.<name>` span carrying its input/output (when capture is
 * on) and error slug on failure. Used by the stages that have no span of their own; understand and
 * agent.generate already own spans and call captureInput/captureOutput on them directly.
 */
export async function instrumentStage<T>(
  name: string,
  input: unknown,
  fn: () => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(`stage.${name}`, async (span) => {
    captureInput(span, input)
    try {
      const out = await fn()
      captureOutput(span, out)
      return out
    } catch (err) {
      recordError(span, err, `err-stage-${name}`)
      throw err
    } finally {
      span.end()
    }
  })
}
