import { Memory } from '@mastra/memory'
import { z } from 'zod'
import { libsqlStore } from '../lib/storage'
import { WORKER_MODEL_ID } from '../lib/provider'

/**
 * Working-memory schema (Zod). Schema mode → MERGE semantics: a partial write (e.g. only
 * `prose_summary`) preserves the other fields. A markdown `template` would use REPLACE semantics
 * and clobber unwritten fields, so we deliberately use `schema`, not `template`.
 *
 * What lives here: durable, non-PII user state that should persist across sessions.
 * What must NOT: PAN / Aadhaar / full mobile, or raw bureau data (fetched fresh each session).
 */
const workingMemorySchema = z.object({
  goals: z.array(z.string()).default([]),              // e.g. ["home loan in 6 months"]
  hard_constraints: z.array(z.string()).default([]),   // e.g. ["max EMI 8000"]
  prose_summary: z.string().default(''),               // rolling 3–5 sentence summary
})

/**
 * Observational Memory (OM) tuning. All env-tunable so a live test can force the Observer to run
 * without pushing 30k real tokens through the model (see `__tests__/om.live.test.ts`).
 *
 * `OM_SCOPE` — 'thread' (default) keys observations by session_id. Mastra's own guidance is thread
 * scope for existing apps: resource scope is experimental, disables async buffering, and reprocesses
 * every thread for a user together. Durable cross-session state is already covered by the
 * resource-scoped working memory above, so thread-scoped OM is the safe default. Flip to 'resource'
 * to opt into cross-conversation observations.
 * `OM_MESSAGE_TOKENS` / `OM_OBSERVATION_TOKENS` — Observer / Reflector trigger thresholds.
 * `OM_ASYNC_BUFFER` — set to 'false' to run the Observer synchronously (deterministic for tests).
 */
// Parse a positive-integer env override; fall back to the default on empty / non-numeric / <= 0
// so a stray OM_*_TOKENS value can't silently make the trigger threshold NaN or 0.
const posInt = (v: string | undefined, dflt: number): number => {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : dflt
}
const OM_SCOPE: 'thread' | 'resource' = process.env.OM_SCOPE === 'resource' ? 'resource' : 'thread'
const OM_MESSAGE_TOKENS = posInt(process.env.OM_MESSAGE_TOKENS, 30_000)
const OM_OBSERVATION_TOKENS = posInt(process.env.OM_OBSERVATION_TOKENS, 40_000)
const OM_ASYNC_BUFFER = process.env.OM_ASYNC_BUFFER !== 'false'

/**
 * THE single Memory instance. Every agent that needs memory imports THIS — never `new Memory()`
 * in an agent file, because multiple instances are disconnected stores and working memory would
 * never accumulate.
 *
 * `storage` is the same `libsqlStore` registered on the Mastra instance (one database file).
 * `workingMemory.scope: 'resource'` persists small structured state per user (resource = user_id)
 * across all sessions; libSQL is a resource-scope-capable adapter (`mastra_resources` table).
 *
 * `observationalMemory` gives every specialist agent humanlike long-context memory: a background
 * Observer compresses old message history into a dense observation log, so long sessions stay on
 * task without carrying raw history. We reuse `WORKER_MODEL_ID` (the same model the worker agents run
 * on) as the Observer/Reflector model, so the whole app keys on one provider key and no separate
 * provider key is needed. libSQL is one of the three OM-supported adapters. OM pulls history
 * from storage by threadId; the workflow already sends only the new turn per call, which is exactly
 * what OM expects (do not send full history when OM is on).
 */
export const credixMemory = new Memory({
  storage: libsqlStore,
  options: {
    lastMessages: 20,
    workingMemory: {
      enabled: true,
      scope: 'resource',
      schema: workingMemorySchema,
    },
    observationalMemory: {
      model: WORKER_MODEL_ID,
      scope: OM_SCOPE,
      observation: {
        messageTokens: OM_MESSAGE_TOKENS,
        ...(OM_ASYNC_BUFFER ? {} : { bufferTokens: false as const }),
      },
      reflection: {
        observationTokens: OM_OBSERVATION_TOKENS,
      },
    },
  },
})
