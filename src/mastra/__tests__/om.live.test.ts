/// <reference types="bun-types" />
import { describe, it, expect, beforeAll } from 'bun:test'

/**
 * LIVE end-to-end test of Observational Memory (OM), nothing mocked.
 *
 * Drives several real turns through the WHOLE credix workflow on a single session (thread):
 * decode -> pre-guardrail -> understand (real Grok) -> specialist agent (real Grok) -> post-guardrail
 * -> memory-writeback. The memory-writeback step is where OM is triggered, so this proves the real
 * production path compresses a conversation into observations. We then read the observation record
 * back with `credixMemory.getContext()`.
 *
 * The bureau profile is supplied inline (a small synthetic doc), so the Python bureau sidecar is not
 * required — this isolates the OM behavior from the data layer.
 *
 * Determinism: OM thresholds/buffering are env-tunable (see memory/index.ts). We set a tiny
 * `OM_MESSAGE_TOKENS` and disable async buffering so the Observer runs the moment a couple of turns
 * exceed the threshold. These env vars MUST be set before the modules are imported, so the imports
 * are dynamic and live in beforeAll (a static import would be hoisted above these assignments).
 *
 * Opt-in only. Runs when:
 *   LIVE_OM=true          enable the suite
 *   GROK_API_KEY set      (from .env; bun auto-loads) — used by understand, the agent, and the Observer
 *
 *   LIVE_OM=true bun test src/mastra/__tests__/om.live.test.ts
 */

const LIVE = process.env.LIVE_OM === 'true'
const HAS_CREDS = Boolean(process.env.GROK_API_KEY)
const run = LIVE && HAS_CREDS

// Force the Observer to fire after a couple of short turns instead of at 30k tokens, synchronously so
// observations exist by the time the workflow run resolves. Set before the dynamic import.
if (run) {
  process.env.OM_SCOPE = 'thread'
  process.env.OM_MESSAGE_TOKENS = '60'
  process.env.OM_ASYNC_BUFFER = 'false'
}

// A minimal masked-style bureau profile so pre-guardrail has something to mask and the agent has
// context, without needing the live bureau sidecar.
const BUREAU_PROFILE = {
  general_info: { credit_score: 731 },
  accounts: [{ type: 'credit_card', status: 'active' }],
}

// Tool-free chit-chat so the specialist agent answers from the persona alone (RAHUL_PERSONA bridges
// small talk to money without a bureau/web tool call) — keeps the turns fast and flake-free.
const TURNS = [
  'Hey Rahul, I spend most weekends watching cricket with friends.',
  'I usually order in a lot of biryani on match days.',
  'By the way my name is Arjun and I want to get better with my monthly budget.',
  'I also dream of taking a Goa trip with my college friends next year.',
]

const USER_ID = '9990001111' // synthetic 10-digit user id (workflow requires length 10)

describe.skipIf(!run)('observational memory — live e2e (real workflow: understand + agent + Observer)', () => {
  let mastra: any
  let credixMemory: any
  const sessionId = `test-om-${Date.now()}`

  beforeAll(async () => {
    ;({ mastra } = (await import('../index')) as any)
    ;({ credixMemory } = (await import('../memory/index')) as any)
  })

  it('compresses a multi-turn conversation into observations readable via getContext', async () => {
    for (const message of TURNS) {
      const run = await mastra.getWorkflow('credixWorkflow').createRun()
      const r = await run.start({
        inputData: {
          user_id: USER_ID,
          message,
          session_id: sessionId,
          channel: 'web',
          bureau_profile: BUREAU_PROFILE,
        },
      })
      // The workflow is designed to degrade gracefully; we only need it to not hard-fail so the turn's
      // messages get persisted for the Observer to see.
      expect(r.status).toBe('success')
    }

    // Sync observation means the record should already exist; poll briefly to absorb any lag.
    let hasObservations = false
    let observations = ''
    for (let attempt = 0; attempt < 6 && !hasObservations; attempt++) {
      const ctx = await credixMemory.getContext({ threadId: sessionId, resourceId: USER_ID })
      hasObservations = ctx.hasObservations
      observations = ctx.omRecord?.activeObservations ?? ''
      if (!hasObservations) await new Promise(r => setTimeout(r, 3000))
    }

    expect(hasObservations).toBe(true)
    expect(observations.length).toBeGreaterThan(0)
    // The observation log is a compression of the conversation, not a transcript, but at least one
    // salient fact the user stated should survive into it.
    expect(observations.toLowerCase()).toMatch(/arjun|budget|cricket|goa|biryani/)
  }, 240_000)
})
