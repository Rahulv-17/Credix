// ─── Injection patterns — pre-guardrail step, checked on decoded user input ───
export const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(previous|prior)\s+instructions?/i,
  /act\s+as\s+(if\s+you\s+are|a)/i,
  /jailbreak/i,
  /\bDAN\b/,
  /pretend\s+you\s+are/i,
  /system\s+prompt/i,
  /new\s+instructions?/i,
  /disregard\s+(all|previous)/i,
]

// ─── Unsafe / abuse patterns — pre-guardrail step, checked on decoded user input ───
// This is the ONLY hard scope floor. Common-interest / lifestyle topics (sport, food,
// weather, astrology, markets) are deliberately NOT blocked: the credix engages with
// them and bridges to the user's finances via RAHUL_PERSONA. Only genuinely harmful
// requests are rejected here. Kept deliberately narrow so real finance queries never
// false-positive (e.g. "loan for my food truck", "loan against shares").
export const UNSAFE_PATTERNS: RegExp[] = [
  /\b(kill|hurt|harm)\s+(myself|yourself|someone|him|her|them)\b/i,
  /\b(suicide|self[-\s]?harm|end\s+my\s+life)\b/i,
  /\bhow\s+to\s+(make|build|create)\s+(a\s+)?(bomb|weapon|explosive|gun)\b/i,
  /\b(buy|sell|make|smuggle)\s+(cocaine|heroin|meth|illegal\s+drugs)\b/i,
  /\b(child\s+abuse|csam|child\s+porn|explicit\s+sexual)\b/i,
]

// ─── PII patterns — post-guardrail step, checked on agent output ───
// PAN: 5 uppercase letters + 4 digits + 1 uppercase letter
export const PAN_PATTERN = /\b[A-Z]{5}[0-9]{4}[A-Z]\b/g
// Aadhaar: 12 digits optionally space-separated in groups of 4
export const AADHAAR_PATTERN = /\b\d{4}\s?\d{4}\s?\d{4}\b/g
// Indian mobile: starts 6–9, followed by 9 more digits
export const MOBILE_PATTERN = /\b[6-9]\d{9}\b/g
// Email: deliberately loose (no TLD whitelist) because this is redaction, not validation — a false
// positive costs a redacted token in a trace, a false negative ships an identifier to a third party.
// The bureau pii block carries one, so it reaches trace payloads the same way a mobile does.
export const EMAIL_PATTERN = /\b[^\s@<>()[\]{},;:"']+@[^\s@<>()[\]{},;:"']+\.[A-Za-z]{2,}\b/g
// CIBIL scores (300–900, always 3 digits) are intentionally NOT redacted

// ─── Canonical intent values — shared between understand step and workflow branch ───
export const INTENT_VALUES = [
  'bureau_query',
  'score_improvement',
  'credit_card',
  'insurance',
  'general',
] as const
export type Intent = typeof INTENT_VALUES[number]

// ─── Delegation summary — legible, deduped view of the master's sub-agent delegations ───
// Fed the ordered list of primitiveIds captured from Mastra's onDelegationStart supervisor hook (the
// first-class delegation signal; see credix-workflow masterStep). The master can delegate to the
// same worker more than once in a turn, so we surface a deduped worker list AND per-worker counts,
// instead of a raw list that reads as noise ("credit-card-agent,credit-card-agent") and loses the count.
export interface DelegationSummary {
  workers: string[] // unique worker ids, first-seen order
  total: number // total delegations this turn (repeats included)
  byWorker: string // "credit-card-agent:2,credix-agent:1" — empty when no delegations
}
export function summarizeDelegations(primitiveIds: string[]): DelegationSummary {
  const counts = new Map<string, number>()
  for (const id of primitiveIds) counts.set(id, (counts.get(id) ?? 0) + 1)
  return {
    workers: [...counts.keys()],
    total: primitiveIds.length,
    byWorker: [...counts.entries()].map(([id, n]) => `${id}:${n}`).join(','),
  }
}

// ─── Canonical step IDs — must match createStep({ id }) exactly ───
// getStepResult() uses these strings. A mismatch silently returns undefined.
export const STEP_IDS = {
  DECODE: 'decode',
  PRE_GUARDRAIL: 'pre-guardrail',
  IDENTITY_CHECK: 'identity-check',
  UNDERSTAND: 'understand',
  MASTER: 'master',
  POST_GUARDRAIL: 'post-guardrail',
  MEMORY_WRITEBACK: 'memory-writeback',
  COMPOSE: 'compose',
  GUARDRAIL_REJECT: 'guardrail-reject',
  SCORE_IMPROVEMENT: 'score_improvement',
  CREDIT_CARD: 'credit_card',
  INSURANCE: 'insurance',
  GENERAL: 'general',
} as const
