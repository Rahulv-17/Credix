import { createStep } from '@mastra/core/workflows'
import { z } from 'zod'
import { STEP_IDS } from '../lib/patterns'
import { normalizeUserId } from '../lib/normalize-user-id'

export { normalizeUserId }

// Called by Hono at the API boundary before the credix workflow starts.
// Never throws: sidecar errors return identity_verified: false with an error code.
export const identityCheckStep = createStep({
  id: STEP_IDS.IDENTITY_CHECK,
  description: 'Normalise mobile to 10-digit user_id; verify user has a bureau record',
  inputSchema: z.object({ mobile: z.string() }),
  outputSchema: z.object({
    user_id: z.string().optional(),
    identity_verified: z.boolean(),
    error: z.string().optional(),
  }),
  execute: async ({ inputData }) => {
    const user_id = normalizeUserId(inputData.mobile)
    if (!user_id) {
      return { identity_verified: false, error: 'invalid_mobile' }
    }

    try {
      const sidecarUrl = process.env.BUREAU_SIDECAR_URL ?? 'http://localhost:8000'
      const token = process.env.INTERNAL_API_SECRET ?? ''
      const res = await fetch(`${sidecarUrl}/internal/bureau/${user_id}`, {
        headers: { 'X-Internal-Token': token },
      })
      if (res.status === 404) {
        return { user_id, identity_verified: false, error: 'no_bureau_record' }
      }
      if (!res.ok) {
        return { user_id, identity_verified: false, error: `sidecar_${res.status}` }
      }
      return { user_id, identity_verified: true }
    } catch {
      return { user_id, identity_verified: false, error: 'sidecar_unreachable' }
    }
  },
})
