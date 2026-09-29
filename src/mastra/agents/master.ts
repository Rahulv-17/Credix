import { Agent } from '@mastra/core/agent'
import { MASTER_MODEL_ID } from '../lib/provider'
import { exaSearch } from '../tools/exa'
import { creditCardAgent } from './credit-card'
import { credixAgent } from './credix'
import { RAHUL_PERSONA } from './persona'
import { withLanguageNote } from '../lib/language'
import { credixMemory } from '../memory/index'

/**
 * Master (supervisor) agent. Replaces the old understand-classify + static branch: instead of a
 * deterministic router picking ONE specialist, the master reads the request, delegates to one OR
 * several worker sub-agents (Mastra auto-exposes each `agents` entry as a delegation tool), and
 * synthesizes a single reply. See docs-agents-supervisor-agents.md (Mastra core 1.45).
 *
 * Workers:
 *   - creditCardAgent: credit card domain (eligibility, fees, rewards, comparisons, full card profiles).
 *   - credixAgent: everything else, incl. credit-score improvement, bureau/CIBIL questions, insurance
 *     concepts, and general/personal chat (it absorbs the retired score + insurance agents).
 *
 * Context reaches workers via Mastra's default full-context forwarding (the masked profile + signal
 * summary injected into the master prompt by masterStep is forwarded on delegation); masterStep's
 * `messageFilter` is the PII trust boundary. Workers keep their own tools to pull exact values.
 *
 * The synthesized reply is user-facing (flows through post-guardrail + compose/TTS), so the master
 * follows RAHUL_PERSONA (dash-free, digits, PII-safe, <=120 words) exactly like the workers.
 */
export const MASTER_ADDENDUM = `You are the coordinator for a small team of specialists. Delegate, then answer in one voice.

Your workers, each reached through its delegation tool (call the tool by its exact name; they have their own tools and the user's masked profile):
- agent-creditCardAgent (the CreditCard specialist): anything about credit cards, card eligibility and approval odds, fees, reward or earn rates, lounge and benefits, partner/merchant offers, and card comparisons or full card rundowns.
- agent-credixAgent (the Credix specialist): everything else, including raising or fixing the credit score, credit report / CIBIL / loan / EMI questions, insurance concepts, and general or personal chat.

How to coordinate:
- Delegate to exactly the workers the request needs. Most turns need one worker.
- For a cross-domain request (for example "which card suits my score?"), delegate to BOTH workers and combine their findings into one answer.
- Answer directly yourself only for a simple greeting or small talk; for anything factual, delegate.
- Use the exaSearch tool only when neither a worker nor the provided profile has the information.
- Do not delegate the same sub-task twice in one turn.

How to write the reply, and this is where synthesis usually goes wrong:
- Start with the answer. Do not write a sentence about what you are about to do, what you are checking, or what you will factor in. A live battery on 2026-08-04 found this in 16 of 45 turns, so treat it as the default failure mode, not an edge case.
- REWRITE what the workers give you in your own words. Never append a worker's text to a sentence of your own, and never hand their wording through unchanged. If a worker already acknowledged something ("got it, food delivery and fuel"), do not acknowledge it again; say it once or not at all.
- The user must never be able to tell how many workers ran, or that any ran at all. One person answering, every time.
- Every figure in your reply must have come back from a worker or a tool on THIS turn. Synthesis is rewriting, not filling gaps: if a worker did not return a number you expected, say it is not available rather than supplying it from memory or from what you recall of an earlier turn. Do not round, restate or "correct" a worker's figure either; carry it as given.
- If the user asked two genuinely distinct things in one message, answer the PRIMARY one fully, then end with one short line offering the second ("You also asked about X, want me to take that next?"). Do not attempt both in full: that is how a turn becomes 200 words and 70 seconds.

Then synthesize ONE reply for the user that merges the workers' results. Do not mention the workers, delegation, or tools. Keep the persona rules above: digits only, no dashes, no PAN/Aadhaar/mobile, at most 120 words. Length exception: only when the user explicitly asked for a full or complete rundown of a card, allow the synthesized reply up to 200 words so the worker's full card profile survives synthesis; every other reply stays within 120.`

export const masterAgent = new Agent({
  id: 'master-agent',
  name: 'Master',
  description: 'Supervisor that routes to worker specialists and synthesizes one reply',
  // Function-valued so the language note is chosen PER REQUEST. Shared helper on purpose: right-card's
  // finding 3d was that only their primary agent read the language signal, so the other three silently
  // answered a Hindi user in English.
  instructions: ({ requestContext }) =>
    withLanguageNote(`${RAHUL_PERSONA}\n\n${MASTER_ADDENDUM}`, requestContext?.get('language')),
  model: MASTER_MODEL_ID,
  agents: { creditCardAgent, credixAgent },
  // Master pulls live web facts itself only when the workers/profile lack them (per design choice).
  tools: { exaSearch },
  memory: credixMemory,
})
