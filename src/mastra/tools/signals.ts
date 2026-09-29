import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { fetchUserStory, peekUserStory } from '../lib/user-story-fetch'
import { resolveUserId } from '../lib/normalize-user-id'
import { tracer } from '../lib/otel'
import { plainSignals } from '../lib/signal-summary'

// Lets an agent read the user's precomputed bureau signals on demand. The payload is fetched once
// per request in Hono and cached in-process (lib/user-story-fetch), so this normally reads the
// cache; on a miss it falls back to a fetch. Optionally narrow to one section.
//   - section 'tier1'   -> 62 base derived variables (incl. exact age, income estimates)
//   - section 'tier2'   -> 34 composite signals
//   - section 'compose' -> trust-gated, severity-ranked signals ready to surface
//   - omitted           -> the whole payload
export const getSignals = createTool({
  id: 'getSignals',
  description:
    "Read the user's precomputed credit signals (derived from their bureau profile). Call with " +
    "`section` = 'compose' for the ready-to-surface, ranked opportunities/risks; 'tier2' for all " +
    'composite signals; \'tier1\' for base variables (age, income estimates, file depth); or omit ' +
    'section for everything. Returns { available: false } when no signals exist for this user.',
  inputSchema: z.object({
    user_id: z
      .string()
      .optional()
      .describe('Leave this out. The server supplies the user id from the request context.'),
    section: z.enum(['tier1', 'tier2', 'compose']).optional(),
  }),
  outputSchema: z.record(z.string(), z.unknown()),
  execute: async (inputData, context) => {
    const { section } = inputData
    // Context-first: server-verified user_id from the central request context, arg as fallback.
    const user_id = resolveUserId(inputData.user_id, context)
    return tracer.startActiveSpan('signals.lookup', async (span) => {
      try {
        let signals = peekUserStory(user_id)
        span.setAttribute('app.signals.cache', signals ? 'hit' : 'miss')
        if (!signals) {
          const res = await fetchUserStory(user_id)
          signals = res.ok ? res.signals : undefined
        }

        if (!signals) {
          span.setAttribute('app.signals.present', false)
          return { available: false, message: 'No computed signals for this user.' }
        }

        // PII-safe span attributes only: presence, counts, and coarse tiers. NEVER exact age,
        // raw score, or income numbers (those live in the payload, not in observability).
        span.setAttribute('app.signals.present', true)
        const compose = Array.isArray(signals.compose) ? signals.compose : []
        span.setAttribute('app.signals.compose_count', compose.length)
        const tier2 = (signals.tier2 ?? {}) as Record<string, unknown>
        if (typeof tier2.AFFLUENCE_TIER === 'string') {
          span.setAttribute('app.signals.affluence_tier', tier2.AFFLUENCE_TIER)
        }
        if (typeof signals.file_tier === 'string') {
          span.setAttribute('app.signals.file_tier', signals.file_tier as string)
        }

        if (section) {
          span.setAttribute('app.signals.section', section)
          return { available: true, section, [section]: signals[section] ?? null }
        }
        // Relabel the internal taxonomy before it reaches the model. The span attribute above keeps the
        // RAW value for observability; only the model-facing payload is made plain (after-battery
        // 2026-08-04: "thick file" survived the summary fix in 4 replies, all via this tool).
        return { available: true, ...plainSignals(signals) }
      } finally {
        span.end()
      }
    })
  },
})
