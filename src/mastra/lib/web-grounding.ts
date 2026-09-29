import type { Span } from '@opentelemetry/api'
import { webSearch } from '../tools/exa'
import { scrubIdentifiers } from './otel'

// Per-turn web grounding: every substantive turn gets a fresh Exa search whose top results are
// injected into the specialist agent's prompt as "Live web context". This makes replies smarter
// (current rates, product terms, news) without waiting for the agent to decide to call the tool.
//
// It needs only the user message, so the understand step runs it CONCURRENTLY with the
// classification LLM call — its ~0.7s hides under the classify latency instead of delaying
// agent.generate. The bureau_query skip therefore lives in understand.ts (intent is only known
// after classification; the step discards the context for that intent).
//
// Fail-soft by construction: any error, timeout, or missing key returns no context, and the turn
// proceeds ungrounded rather than 502-ing.

const GROUNDING_TIMEOUT_MS = 4000
const GROUNDING_NUM_RESULTS = 3
const MAX_EXCERPT_CHARS = 320

// Turns that don't benefit from the web: greetings and trivially short messages. The AutoOpener
// fires "Hi" on load, so greeting detection also keeps the opening turn fast and web-free.
const GREETING_RE =
  /^(hi|hey+|hello|yo|sup|hola|namaste|greetings|good\s+(morning|afternoon|evening|day))\b[!.\s]*$/i

// No category bias here on purpose: Exa's "financial report" category skews to SEC/regulatory
// filings, which are useless for advising a consumer. Default relevance surfaces the explainer
// articles and current-rate pages a credix actually needs. The exaSearch tool still lets the
// agent set a category explicitly when it wants (e.g. "news" for a current-events question).

export function shouldGroundWithWeb(message: string): boolean {
  const trimmed = message.trim()
  if (trimmed.length < 8) return false // too short to carry a real question
  if (GREETING_RE.test(trimmed)) return false
  return true
}

function formatContext(results: { title: string; url: string; excerpt: string }[]): string {
  const lines = results
    .filter((r) => r.excerpt || r.title)
    .map((r) => {
      const excerpt = r.excerpt.replace(/\s+/g, ' ').slice(0, MAX_EXCERPT_CHARS)
      return `- ${r.title || r.url}: ${excerpt} (source: ${r.url})`
    })
  return lines.join('\n')
}

// Returns a "Live web context" block for the prompt, or '' when grounding is skipped or fails.
// `span` is optional; when present, records PII-safe grounding attributes.
export async function groundWithWeb(message: string, span?: Span): Promise<string> {
  if (!shouldGroundWithWeb(message)) {
    span?.setAttribute('app.web_grounding.used', false)
    return ''
  }

  // Redact hard identifiers (PAN / Aadhaar / mobile) before the message leaves the service for Exa,
  // a third-party search provider. Only the search query is scrubbed; the classification LLM and the
  // specialist agents still receive the full decoded_text, so answer quality is unaffected.
  const raw = message.trim()
  const query = scrubIdentifiers(raw)
  span?.setAttribute('app.web_grounding.scrubbed', query !== raw)

  // Hoisted so the finally can clear it whichever branch of the race wins; an uncleared timer keeps
  // the event loop busy for the full timeout on every grounded turn.
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const results = await Promise.race([
      webSearch(query, { numResults: GROUNDING_NUM_RESULTS }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('web grounding timed out')), GROUNDING_TIMEOUT_MS)
      }),
    ])

    const context = formatContext(results)
    span?.setAttribute('app.web_grounding.used', context.length > 0)
    span?.setAttribute('app.web_grounding.results', results.length)
    if (!context) return ''

    return [
      'Live web context (fresh search results for this turn; use only what is relevant, and',
      'attribute claims to the source name, never paste raw URLs into your reply):',
      context,
    ].join('\n')
  } catch (err) {
    // Fail soft: grounding is an enhancement, never a hard dependency.
    console.warn(
      `[web-grounding] skipped: ${err instanceof Error ? err.message : String(err)}`,
    )
    span?.setAttribute('app.web_grounding.used', false)
    span?.setAttribute('app.web_grounding.error', err instanceof Error ? err.name : 'unknown')
    return ''
  } finally {
    clearTimeout(timer)
  }
}
