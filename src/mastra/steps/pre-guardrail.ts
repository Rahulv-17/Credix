import { createStep } from '@mastra/core/workflows'
import { z } from 'zod'
import { INJECTION_PATTERNS, UNSAFE_PATTERNS, STEP_IDS } from '../lib/patterns'
import { instrumentStage } from '../lib/otel'

// Partial masking: strips spaces, keeps first `prefix` and last `suffix` chars, X's the middle.
// Mobile (10 digits): partialMask('9876543210', 2, 4) → '98XXXX3210'
// PAN (10 chars):     partialMask('ABCDE1234F', 3, 3) → 'ABCXXXX34F'
// Aadhaar (12 digits):partialMask('444455556666', 0, 4) → 'XXXXXXXX6666'
function partialMask(value: string, prefix: number, suffix: number): string {
  const clean = value.replace(/\s/g, '')
  if (clean.length <= prefix + suffix) return 'X'.repeat(clean.length)
  const middle = 'X'.repeat(clean.length - prefix - suffix)
  return clean.slice(0, prefix) + middle + (suffix > 0 ? clean.slice(-suffix) : '')
}

// Sections that carry no user-identity PII — forwarded whole. Mirrors VALID_SECTIONS in
// tools/bureau.ts, minus general_info (which mixes PII like full_name with safe signals).
// CONTRACT: these sections are aggregate financial data (loan counts, DPD buckets, enquiry
// counts) per the sidecar's section schema — they must NOT nest identity fields (name/dob/
// address/co-applicant KYC). If that ever changes, switch to a per-section key allowlist here.
const SAFE_SECTIONS = [
  'loan_details', 'enquiries', 'loan_repayments', 'loan_patterns',
  'borrowing_window', 'institution_details', 'dpd',
] as const

// general_info mixes PII (full_name) with safe signals — forward only these subkeys.
const GENERAL_INFO_ALLOWLIST = ['credit_score'] as const

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

// Deny-by-default: build a FRESH object so only allowlisted fields can ever reach the LLM.
// Never spread the raw bureau doc — that leaks unmasked PII (full_name, pii.email/dob, and any
// field the sidecar adds later). Widen the allowlists deliberately when Issue 004 agents need more.
function maskProfilePii(profile: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}

  // user_id — the normalized 10-digit mobile used as the bureau document key
  if (typeof profile.user_id === 'string' && /^\d{10}$/.test(profile.user_id)) {
    out.user_id = partialMask(profile.user_id, 2, 4)
  }

  // general_info — only allowlisted non-PII subkeys (drops full_name and anything else)
  if (isPlainObject(profile.general_info)) {
    const safe: Record<string, unknown> = {}
    for (const key of GENERAL_INFO_ALLOWLIST) {
      // structuredClone so masked_profile never aliases the raw fetched doc
      if (key in profile.general_info) safe[key] = structuredClone(profile.general_info[key])
    }
    out.general_info = safe
  }

  // Pure-financial sections — no user-identity PII inside, forwarded whole.
  // Cloned so downstream mutation of masked_profile can't bleed into the raw profile.
  for (const section of SAFE_SECTIONS) {
    if (section in profile) out[section] = structuredClone(profile[section])
  }

  // pii — rebuild with ONLY the 3 known fields, each partially masked; drop every other pii.* key
  if (isPlainObject(profile.pii)) {
    const pii = profile.pii
    const maskedPii: Record<string, unknown> = {}
    if (typeof pii.mobile === 'string') maskedPii.mobile = partialMask(pii.mobile, 2, 4)
    if (typeof pii.pan === 'string') maskedPii.pan = partialMask(pii.pan, 3, 3)
    if (typeof pii.aadhaar === 'string') maskedPii.aadhaar = partialMask(pii.aadhaar, 0, 4)
    out.pii = maskedPii
  }

  return out
}

export const preGuardrailStep = createStep({
  id: STEP_IDS.PRE_GUARDRAIL,
  description: 'Block injection/unsafe queries; partially mask the pre-fetched profile for LLM context',
  inputSchema: z.object({ decoded_text: z.string() }),
  outputSchema: z.object({
    pre_guardrail: z.boolean(),
    guardrail_reason: z.string().optional(),
    decoded_text: z.string(),
    masked_profile: z.record(z.string(), z.unknown()).optional(),
  }),
  execute: async ({ inputData, getInitData }) =>
    instrumentStage(STEP_IDS.PRE_GUARDRAIL, inputData, async () => {
    const text = inputData.decoded_text

    // Fast path: injection and unsafe/abuse checks before any work. Common-interest topics
    // are intentionally NOT screened here — they flow to the LLM, which bridges them to
    // finance via RAHUL_PERSONA. Only genuinely harmful requests are rejected.
    for (const pattern of INJECTION_PATTERNS) {
      if (pattern.test(text)) {
        return { pre_guardrail: false, guardrail_reason: 'injection', decoded_text: text }
      }
    }
    for (const pattern of UNSAFE_PATTERNS) {
      if (pattern.test(text)) {
        return { pre_guardrail: false, guardrail_reason: 'unsafe', decoded_text: text }
      }
    }

    // Single-fetch architecture: the bureau profile is fetched ONCE in Hono and passed in as
    // workflow input. This step no longer fetches — it just deny-by-default masks the passed-in
    // profile for safe downstream LLM use. (Closes Sudhanshu review #3 — no duplicated fetch.)
    let masked_profile: Record<string, unknown> | undefined
    const init = getInitData<{ bureau_profile?: unknown }>()
    if (isPlainObject(init?.bureau_profile)) {
      masked_profile = maskProfilePii(init.bureau_profile)
    }

    return { pre_guardrail: true, decoded_text: text, masked_profile }
    }),
})
