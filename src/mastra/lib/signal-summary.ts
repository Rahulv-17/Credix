/**
 * Build a compact, PII-safe persona summary from the precomputed signal payload, for injection into
 * a specialist's prompt (the "push" path). The whole payload is also reachable on demand via the
 * getSignals tool (the "pull" path); this summary just puts the headline signals in front of the
 * model every turn without a tool round-trip.
 *
 * Deliberately terse: segment / file depth / life stage, then the top gated compose bullets. The
 * exact age and income numbers are NOT spelled here (they stay tool-pullable); this string is safe
 * to sit in a prompt and is never used as a span attribute.
 */

type Signals = Record<string, unknown>

/** Internal file-depth taxonomy -> what a person would actually say. Unknown values fall back to
 *  "<value> credit history", which is still plainer than "<value> file".
 *  Exported because the getSignals TOOL output is a second mouth feeding the model the same words: the
 *  after-battery (2026-08-04) still found "thick file" in 4 replies once this summary was fixed, all of
 *  them on turns that called getSignals and read the raw payload. Same taxonomy, one source of truth. */
export const FILE_TIER_WORDS: Record<string, string> = {
  thick: 'long credit history',
  thin: 'short credit history',
  medium: 'moderate credit history',
}

/** Relabel the internal taxonomy fields on a signals payload before it reaches the model. */
export function plainSignals(signals: Record<string, unknown>): Record<string, unknown> {
  const out = { ...signals }
  if (typeof out.file_tier === 'string') {
    out.file_tier = FILE_TIER_WORDS[out.file_tier] ?? `${out.file_tier} credit history`
  }
  if (typeof out.segment === 'string' && out.segment !== 'no_score') {
    out.segment = `${out.segment} score band`
  }
  return out
}

interface ComposeItem {
  label?: unknown
  verdict?: unknown
}

export function buildSignalSummary(signals: Signals | undefined, maxBullets = 3): string {
  if (!signals || typeof signals !== 'object') return ''

  // Relabel ONCE, through the same function the getSignals tool uses, then read the plain fields. This
  // used to re-implement the mapping inline, directly under a comment claiming one source of truth, which
  // is exactly the drift that comment was warning about (PR #20 review).
  //
  // Plain language matters here because whatever this string says is what the model says back. The
  // 2026-08-04 battery flagged "thick file" in 13 of 45 replies and "prime segment" in 2: the model was
  // echoing THIS summary verbatim, not inventing jargon. Banning the words in the prompt while handing
  // them over here would have been a rule fighting its own input.
  const plain = plainSignals(signals)
  const parts: string[] = []
  const head: string[] = []
  if (typeof plain.segment === 'string' && plain.segment !== 'no_score') head.push(plain.segment)
  if (typeof plain.file_tier === 'string') head.push(plain.file_tier)
  if (typeof plain.life_stage === 'string' && plain.life_stage) {
    head.push(`${plain.life_stage} life-stage`)
  }
  if (head.length) parts.push(head.join(', '))

  const compose = Array.isArray(signals.compose) ? (signals.compose as ComposeItem[]) : []
  const bullets = compose
    .slice(0, maxBullets)
    .filter((c) => typeof c?.label === 'string')
    .map((c) => `- ${c.label}: ${typeof c.verdict === 'string' ? c.verdict : ''}`.trimEnd())

  if (!parts.length && !bullets.length) return ''

  const lines = ['Computed signals for this user:']
  if (parts.length) lines.push(parts.join(' | '))
  lines.push(...bullets)
  lines.push('(Call getSignals for the full set: exact age, income estimates, all 96 signals.)')
  return lines.join('\n')
}
