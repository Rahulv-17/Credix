import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { BureauSidecarError } from '../lib/errors'
import { resolveUserId } from '../lib/normalize-user-id'

const VALID_SECTIONS = [
  'general_info', 'loan_details', 'enquiries', 'loan_repayments',
  'loan_patterns', 'borrowing_window', 'institution_details', 'dpd',
] as const

// CONTRACT: stripPii is for the FULL profile document only — that is always a JSON object, so a
// non-object here means the sidecar regressed and we surface a 502 rather than masking it behind an
// apparently-successful empty result. Do NOT use this on section responses, which may be bare arrays
// (review #5) — getBureauDetail handles those itself.
function stripPii(data: unknown): Record<string, unknown> {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new BureauSidecarError(502, 'unexpected sidecar response shape')
  }
  const obj = { ...(data as Record<string, unknown>) }
  delete obj['pii']
  return obj
}

export const getBureauProfile = createTool({
  id: 'getBureauProfile',
  description: 'Fetch a PII-stripped bureau profile for a user from the credit bureau sidecar.',
  inputSchema: z.object({ user_id: z.string() }),
  outputSchema: z.record(z.string(), z.unknown()),
  execute: async (inputData) => {
    const { user_id } = inputData
    const sidecarUrl = process.env.BUREAU_SIDECAR_URL ?? 'http://localhost:8000'
    const token = process.env.INTERNAL_API_SECRET ?? ''
    const res = await fetch(`${sidecarUrl}/internal/bureau/${encodeURIComponent(user_id)}`, {
      headers: { 'X-Internal-Token': token },
    })
    if (!res.ok) throw new BureauSidecarError(res.status)
    return stripPii(await res.json())
  },
})

export const getBureauDetail = createTool({
  id: 'getBureauDetail',
  description: 'Fetch a single section of a bureau profile (e.g. loan_details, dpd).',
  inputSchema: z.object({
    user_id: z
      .string()
      .optional()
      .describe('Leave this out. The server supplies the user id from the request context.'),
    section: z.enum(VALID_SECTIONS),
  }),
  outputSchema: z.record(z.string(), z.unknown()),
  execute: async (inputData, context) => {
    const { section } = inputData
    // Context-first: prefer the server-verified user_id from the central request context; fall back
    // to the LLM-supplied arg if the context is absent (e.g. a direct tool call outside a run).
    const user_id = resolveUserId(inputData.user_id, context)
    const sidecarUrl = process.env.BUREAU_SIDECAR_URL ?? 'http://localhost:8000'
    const token = process.env.INTERNAL_API_SECRET ?? ''
    const res = await fetch(`${sidecarUrl}/internal/bureau/${encodeURIComponent(user_id)}/${encodeURIComponent(section)}`, {
      headers: { 'X-Internal-Token': token },
    })
    if (!res.ok) throw new BureauSidecarError(res.status, `section ${section}`)
    // A section body may legitimately be a bare array (e.g. a list of loans), so we don't run it
    // through the full-profile stripPii object guard, which 502s on non-objects (review #5). For an
    // object body we still defensively drop any `pii` key; a bare array carries no pii and is wrapped
    // under the section key so the record outputSchema holds.
    const body = (await res.json()) as unknown
    if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
      const obj = { ...(body as Record<string, unknown>) }
      delete obj['pii']
      return obj
    }
    return { [section]: body }
  },
})
