import { createWorkflow, createStep } from '@mastra/core/workflows'
import { z } from 'zod'
import { decodeStep } from '../steps/decode'
import { preGuardrailStep } from '../steps/pre-guardrail'
import { postGuardrailStep } from '../steps/post-guardrail'
import { memoryWritebackStep } from '../steps/memory-writeback'
import { composeStep } from '../steps/compose'
import { masterAgent } from '../agents'
import { STEP_IDS, summarizeDelegations } from '../lib/patterns'
import { tracer, recordError, captureInput, captureOutput } from '../lib/otel'
import { withRetry } from '../lib/retry'
import { hasStatement } from '../lib/statement-store'
import { buildSignalSummary } from '../lib/signal-summary'

// ── Workflow input ──────────────────────────────────────────────────────────────
// Identity normalization + bureau fetch happen in Hono BEFORE the workflow (single-fetch).
// The workflow receives a verified user_id and the pre-fetched bureau_profile.
const workflowInput = z.object({
  user_id: z.string().length(10),
  message: z.string().min(1),
  session_id: z.string(),
  channel: z.enum(['web', 'whatsapp', 'tts']).default('web'),
  bureau_profile: z.record(z.string(), z.unknown()),
  // Precomputed persona signals (full tier1/tier2/compose). Optional: enrichment only, absent
  // when the story sidecar missed. Read by makeAgentStep (prompt summary) and the getSignals tool.
  signals: z.record(z.string(), z.unknown()).optional(),
})
type WorkflowInput = z.infer<typeof workflowInput>

const workflowOutput = z.object({
  composed: z.string(),
  channel: z.enum(['web', 'whatsapp', 'tts']),
  active_skill: z.string(),
  session_id: z.string(),
  // Surfaced so the API/client knows a tts turn fell back to text (audio synthesis failed).
  tts_failed: z.boolean().default(false),
  // Surfaced so the API/client (and 5xx-based alerting) can see a real backend degradation even
  // though the turn returned a safe 200 fallback: an LLM outage in understand or a specialist agent.
  // `error_code` carries the first marker seen (understand_error | agent_generate_failed).
  degraded: z.boolean().default(false),
  error_code: z.string().optional(),
})

// ── Agent step output — every branch produces this exact shape ──────────────────
const agentOutputSchema = z.object({
  raw_response: z.string(),
  tool_calls_log: z.array(
    z.object({
      tool: z.string(),
      input: z.record(z.string(), z.unknown()),
      output: z.unknown().nullable(),
    }),
  ),
  active_skill: z.string(),
  // Observable degradation marker: set when the specialist LLM call failed after retries and
  // this step returned a safe fallback reply instead of throwing (mirrors understand_error).
  agent_error: z.string().optional(),
})
type AgentOutput = z.infer<typeof agentOutputSchema>

// ── Branch input — pre-guardrail's output; shared by guardrailRejectStep + masterStep ────────────
// Mastra requires every branch step to share one input schema. Was understandOutputSchema; now the
// branch runs straight after pre-guardrail (understand is gone), so the shared input IS its output.
const routeInputSchema = z.object({
  pre_guardrail: z.boolean(),
  guardrail_reason: z.string().optional(),
  decoded_text: z.string(),
  masked_profile: z.record(z.string(), z.unknown()).optional(),
})

// ── masterStep — the supervisor. Replaces the understand classifier AND the per-specialist branch:
// the master reads the request, delegates to worker sub-agents (creditCard / credix), and
// synthesizes ONE reply. Workers are configured on masterAgent.agents; Mastra forwards the master's
// context to them on delegation, so the masked profile + signals injected here reach the workers.
const masterStep = createStep({
  id: STEP_IDS.MASTER,
  inputSchema: routeInputSchema,
  outputSchema: agentOutputSchema,
  execute: async ({ inputData, getInitData, requestContext, tracingContext }) => {
    const init = getInitData() as WorkflowInput
    const masked = (inputData.masked_profile ?? {}) as Record<string, unknown>

    // Inject the masked profile MINUS its identifier fields (the pii block + top-level user_id):
    // the workers need financial sections, not identifiers, and partially-masked ids slip past
    // postGuardrailStep. The real user_id for tool calls is passed separately below. Compact JSON to
    // keep per-turn prompt tokens down.
    const maskedForPrompt = { ...masked }
    delete maskedForPrompt.pii
    delete maskedForPrompt.user_id
    const bureauContext = Object.keys(maskedForPrompt).length
      ? JSON.stringify(maskedForPrompt)
      : 'none available'

    // Custom span over the master LLM loop. Auto-instrumented model HTTP calls (master + delegated
    // workers) nest under this. Attributes are PII-safe: skill, tool-call count, delegated workers.
    return tracer.startActiveSpan('agent.generate', async (span) => {
      span.setAttribute('app.active_skill', STEP_IDS.MASTER)

      // If the user uploaded a statement, tell the master so it can route a getStatement pull.
      const statementHint = hasStatement(init.user_id)
        ? 'The user has uploaded a bank/credit statement. Have the relevant worker use the getStatement tool when relevant.'
        : ''

      // Push the headline persona signals (PII-safe summary). Exact age/income stay pullable via
      // the getSignals tool by the workers. No intent line (the master classifies itself) and no web
      // prefetch (the master calls exaSearch on demand).
      const signalSummary = buildSignalSummary(init.signals)

      const prompt = [
        `User profile (masked):\n${bureauContext}`,
        signalSummary,
        statementHint,
        // Use decoded_text (NFC-normalized, and what pre-guardrail evaluated), not the raw init.message,
        // so the master sees exactly the string the normalization + guardrail pipeline vetted.
        `User message: ${inputData.decoded_text}`,
        // No user_id line here on purpose (PR #19 review): the tools read the server-verified id from
        // requestContext, so putting a hard identifier in the prompt only re-invited the LLM echo that
        // ZT-730 removed, and shipped a mobile number to the model provider on every turn.
      ].filter(Boolean).join('\n\n')

      captureInput(span, prompt)
      try {
        // Every sub-agent delegation this turn, in order, captured from Mastra's first-class
        // onDelegationStart hook. The hook fires once per delegation, so repeat delegations to the same
        // worker are counted (not lost, and not reverse-engineered from `agent-<key>` tool names).
        const delegations: string[] = []

        // Retry transient upstream failures (5xx / 429). withRetry fast-fails true 4xx.
        const result = await withRetry(
          () => {
            // Reset per attempt: withRetry re-invokes this thunk, and only the final (successful)
            // attempt's delegations should be recorded, so a retried call never double-counts.
            delegations.length = 0
            return masterAgent.generate(prompt, {
              // Forward the central per-request context so the master, and the workers it delegates
              // to, expose user_id (+ channel) to their tools via context.requestContext.
              requestContext,
              // Nest the agent's AI spans under the workflow trace. Without this the master starts
              // its own root trace, so one turn showed up in Langfuse as TWO unrelated traces
              // ('credix-workflow' and 'Master') and the session/user metadata on the workflow
              // trace never reached the generation spans.
              tracingContext,
              maxSteps: 5,
              memory: { resource: init.user_id, thread: init.session_id },
              delegation: {
                // Cap forwarded context size. The master prompt already carries only MASKED profile
                // data and postGuardrailStep scrubs the final reply, so this is a size/defense bound.
                messageFilter: ({ messages }) => messages.slice(-20),
                // Record the delegated worker's id. Returning void proceeds with the delegation as-is.
                onDelegationStart: ({ primitiveId }) => {
                  delegations.push(primitiveId)
                },
              },
            })
          },
          `agent:${STEP_IDS.MASTER}`,
        )

        // tool_calls_log from the step trace (delegations to workers appear here as tool calls).
        const tool_calls_log: AgentOutput['tool_calls_log'] = []
        for (const step of (result.steps ?? []) as any[]) {
          for (const tc of (step.toolCalls ?? []) as any[]) {
            const tr = (step.toolResults ?? []).find(
              (r: any) => r?.payload?.toolCallId === tc?.payload?.toolCallId,
            )
            tool_calls_log.push({
              tool: tc?.payload?.toolName ?? 'unknown',
              input: (tc?.payload?.args ?? {}) as Record<string, unknown>,
              output: tr?.payload?.result ?? null,
            })
          }
        }
        span.setAttribute('app.tool_calls.count', tool_calls_log.length)
        // Delegations tracked via the onDelegationStart hook above (not parsed from tool names). Record a
        // deduped worker list plus the total and per-worker counts, so a worker delegated 2-3 times stays
        // legible and countable rather than repeating in one noisy attribute.
        const delegationSummary = summarizeDelegations(delegations)
        if (delegationSummary.total) {
          span.setAttribute('app.delegated_workers', delegationSummary.workers.join(','))
          span.setAttribute('app.delegations.count', delegationSummary.total)
          span.setAttribute('app.delegations.by_worker', delegationSummary.byWorker)
        }

        const responseText = result.text?.trim()
        span.setAttribute('app.response.empty', !responseText)
        const raw_response = responseText || 'I was unable to generate a response. Please try again.'

        const out = { raw_response, tool_calls_log, active_skill: STEP_IDS.MASTER }
        captureOutput(span, out)
        return out
      } catch (err) {
        // Fail soft: a master/worker LLM outage must not 502 the turn. Record, then return a safe,
        // retryable reply that still flows through post-guardrail and compose.
        recordError(span, err, 'err-agent-generate-failed')
        span.setAttribute('app.agent.error', 'agent_generate_failed')
        const out = {
          raw_response: 'I hit a snag putting that together. Please try again in a moment.',
          tool_calls_log: [],
          active_skill: STEP_IDS.MASTER,
          agent_error: 'agent_generate_failed',
        }
        captureOutput(span, out)
        return out
      } finally {
        span.end()
      }
    })
  },
})

// ── guardrailRejectStep — fires when pre-guardrail blocked the query ─────────────
// Same input/output schema as the specialists (branch invariant). No LLM call.
const guardrailRejectStep = createStep({
  id: STEP_IDS.GUARDRAIL_REJECT,
  inputSchema: routeInputSchema,
  outputSchema: agentOutputSchema,
  execute: async ({ inputData }) => ({
    raw_response:
      inputData.guardrail_reason === 'injection'
        ? "I'm here to help with credit questions. Let's stay focused on your credit journey."
        : "I can't help with that one, but I'm always here for your money and daily-life goals. What's on your mind there?",
    tool_calls_log: [],
    active_skill: STEP_IDS.GUARDRAIL_REJECT,
  }),
})

// Collapse the fired branch (getStepResult returns null for the branch that did not run).
function firedBranch(getStepResult: (id: string) => unknown): AgentOutput | null {
  return (
    (getStepResult(STEP_IDS.GUARDRAIL_REJECT) ?? getStepResult(STEP_IDS.MASTER)) as AgentOutput | null
  )
}

export const credixWorkflow = createWorkflow({
  id: 'credix-workflow',
  inputSchema: workflowInput,
  outputSchema: workflowOutput,
})
  .then(decodeStep)
  .then(preGuardrailStep)
  // Two mutually exclusive arms: a blocked query takes the no-LLM reject; everything else goes to the
  // master, which understands the request itself and delegates to the worker sub-agents. (Mastra
  // .branch() runs EVERY truthy arm, so `pre_guardrail` and `!pre_guardrail` keep them exclusive.)
  .branch([
    [async ({ inputData }) => !inputData.pre_guardrail, guardrailRejectStep],
    [async ({ inputData }) => inputData.pre_guardrail, masterStep],
  ])
  // Seam 1: collapse the branch object → agentOutputSchema for postGuardrailStep.
  .map(async ({ getStepResult }) => {
    const r = firedBranch(getStepResult as (id: string) => unknown)
    return {
      raw_response: r?.raw_response ?? '',
      tool_calls_log: r?.tool_calls_log ?? [],
      active_skill: r?.active_skill ?? STEP_IDS.GENERAL,
    }
  })
  .then(postGuardrailStep)
  .then(memoryWritebackStep)
  // Seam 2: postGuardrail dropped active_skill, and compose reads everything from inputData (it has
  // no getInitData), so rebuild compose's input here.
  .map(async ({ getStepResult, getInitData }) => {
    const init = getInitData() as WorkflowInput
    const post = getStepResult(STEP_IDS.POST_GUARDRAIL) as { response: string } | null
    const r = firedBranch(getStepResult as (id: string) => unknown)
    // Recover the degradation marker: masterStep returns its safe fallback reply (agent_error) after
    // retries instead of throwing, so this is the only signal a real backend outage occurred.
    const error_code = r?.agent_error
    return {
      response: post?.response ?? '',
      channel: init.channel,
      session_id: init.session_id,
      active_skill: r?.active_skill ?? STEP_IDS.GENERAL,
      degraded: Boolean(error_code),
      error_code,
    }
  })
  .then(composeStep)
  .commit()
