import { createStep } from '@mastra/core/workflows'
import { z } from 'zod'
import { STEP_IDS } from '../lib/patterns'
import { instrumentStage, tracer, recordError } from '../lib/otel'
import { credixMemory } from '../memory/index'

/**
 * Memory writeback — drives Observational Memory (OM) at the end of each turn.
 *
 * OM's automatic observe-on-turn trigger does not fire through the workflow's non-streaming
 * `agent.generate` path, so we trigger it here explicitly at the point OM's own docs prescribe:
 * `finalize()` "at the end of a conversation, session, or turn sequence". By now the specialist agent
 * has already persisted this turn's messages, so the Observer sees the full unobserved history.
 *
 * We delegate the WHEN to OM itself: `getStatus()` (a pure read — storage load + token count, no LLM)
 * reports whether the message/observation thresholds are crossed. We only spend an Observer/Reflector
 * LLM call when OM says to. Everything here is fail-soft: memory bookkeeping must never break a reply.
 *
 * Structurally still a pass-through of `{ response }` so the workflow chain is unchanged; it sits
 * between postGuardrailStep ({response}) and the buildComposeInput .map() in credix-workflow.ts.
 */
export const memoryWritebackStep = createStep({
  id: STEP_IDS.MEMORY_WRITEBACK,
  description: 'Memory writeback — trigger OM observation/reflection for the thread (fail-soft)',
  inputSchema: z.object({ response: z.string() }),
  outputSchema: z.object({ response: z.string() }),
  execute: async ({ inputData, getInitData }) =>
    instrumentStage(STEP_IDS.MEMORY_WRITEBACK, inputData, async () => {
      const init = getInitData() as { user_id?: string; session_id?: string }
      const threadId = init?.session_id
      const resourceId = init?.user_id

      // Thread scope needs a threadId; without one, skip silently (nothing to key observations on).
      if (threadId) {
        await tracer.startActiveSpan('om.writeback', async (span) => {
          try {
            const engine = await credixMemory.omEngine
            if (engine) {
              const status = await engine.getStatus({ threadId, resourceId })
              span.setAttribute('app.om.pending_tokens', status.pendingTokens)
              span.setAttribute('app.om.should_observe', status.shouldObserve)
              // finalize() activates any buffered chunks and observes if the threshold is crossed.
              if (status.shouldObserve || status.canActivate || status.bufferedChunkCount > 0) {
                const r = await engine.finalize({ threadId, resourceId })
                span.setAttribute('app.om.observed', Boolean(r?.observed))
              }
              // Reflection is re-checked after a possible observe: condense once observations grow large.
              const post = await engine.getStatus({ threadId, resourceId })
              if (post.shouldReflect) {
                await engine.reflect(threadId, resourceId)
                span.setAttribute('app.om.reflected', true)
              }
            }
          } catch (err) {
            // Never fail the turn on a memory hiccup — record and move on.
            recordError(span, err, 'err-om-writeback')
          } finally {
            span.end()
          }
        })
      }

      return { response: inputData.response }
    }),
})
