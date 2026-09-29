/// <reference types="bun-types" />
import { describe, it, expect, mock } from 'bun:test'
import { agentMockFactory } from './agent-mock'

// Shared stub so the agent singletons are controllable across all agent-touching test files
// (see agent-mock.ts). bun does NOT hoist mock.module above static imports, and the specialist
// agents are constructed eagerly at barrel import — so we dynamic-import the barrel AFTER the mock
// is registered (top-level await), guaranteeing the agents build as stubs.
mock.module('@mastra/core/agent', agentMockFactory)

const { creditCardAgent, credixAgent, masterAgent } = await import('../agents')
const { CREDIT_CARD_ADDENDUM } = await import('../agents/credit-card')
const { CREDIX_ADDENDUM } = await import('../agents/credix')
const { credixMemory } = await import('../memory/index')

// Smoke test: every specialist agent instantiates with grokModel + credixMemory + the right tools
// wired (closes Sudhanshu review #4 — provider exports no longer dead). The stub captures the
// constructor config, so we assert id/name/model/memory/tools without a network call.
// getBureauProfile is intentionally absent everywhere: the masked profile is injected into every
// specialist prompt, so the tool only bought an extra LLM round-trip (2026-07-08 latency fix).
// `instructions` is function-valued since the language port (lib/language): Mastra resolves it per
// request so the master AND the delegated workers answer in the user's register. Resolve it here with a
// stub requestContext so these assertions keep testing the composed prompt rather than its shape.
const resolveInstructions = (agent: any, language?: string): string => {
  const instr = agent.config.instructions
  return typeof instr === 'function'
    ? instr({ requestContext: { get: (k: string) => (k === 'language' ? language : undefined) } })
    : instr
}

const all = [
  { agent: creditCardAgent as any, id: 'credit-card-agent', name: 'CreditCard', tools: ['getBureauDetail', 'checkCardEligibility', 'exaSearch', 'getStatement', 'getSignals', 'getCardCriteria', 'getCardFees', 'getCardPartnerRates', 'getCardBenefits', 'getCardDetails', 'getCardFullProfile', 'compareCards'] },
  { agent: credixAgent as any, id: 'credix-agent', name: 'Credix', tools: ['getBureauDetail', 'exaSearch', 'getStatement', 'getSignals'] },
  // Master (supervisor): its own tool set is just exaSearch; the workers are on `agents`, not `tools`.
  { agent: masterAgent as any, id: 'master-agent', name: 'Master', tools: ['exaSearch'] },
]

describe('specialist agents — instantiation smoke', () => {
  for (const { agent, id, name, tools } of all) {
    it(`${name} instantiates with correct id, model, memory, and tools`, () => {
      expect(agent.config.id).toBe(id)
      expect(agent.config.name).toBe(name)
      expect(agent.config.model).toBeDefined()        // grokModel wired (review #4)
      expect(agent.config.memory).toBeDefined()        // credixMemory wired
      expect(Object.keys(agent.config.tools ?? {}).sort()).toEqual([...tools].sort())
    })
  }

  it('all agents share the SAME credixMemory singleton', async () => {
    const mems = await Promise.all(all.map(a => a.agent.getMemory()))
    for (const m of mems) {
      expect(m).toBeDefined()
      expect(m).toBe(credixMemory)
    }
  })
})

describe('creditCardAgent — card discipline addendum', () => {
  it('appends CREDIT_CARD_ADDENDUM after the shared persona', () => {
    const instr = resolveInstructions(creditCardAgent)
    expect(instr).toContain(CREDIT_CARD_ADDENDUM)
    // stable markers so a reworded persona/addendum still fails loudly if the discipline is dropped
    expect(instr).toContain('getCardFullProfile')
    expect(instr).toContain('not published')
  })

  it('only creditCardAgent carries the addendum (score/insurance/credix untouched)', () => {
    for (const { agent, name } of all) {
      if (name === 'CreditCard') continue
      expect(resolveInstructions(agent).includes(CREDIT_CARD_ADDENDUM)).toBe(false)
    }
  })
})

describe('credixAgent — analysis addendum', () => {
  it('appends CREDIX_ADDENDUM after the shared persona', () => {
    const instr = resolveInstructions(credixAgent)
    expect(instr).toContain(CREDIX_ADDENDUM)
    // stable markers so a reworded persona/addendum still fails loudly if the discipline is dropped
    expect(instr).toContain('section compose')
    expect(instr).toContain('under 40% of take-home income')
  })

  it('only credixAgent carries its addendum (card/master untouched)', () => {
    for (const { agent, name } of all) {
      if (name === 'Credix') continue
      expect(resolveInstructions(agent).includes(CREDIX_ADDENDUM)).toBe(false)
    }
  })
})

// ── Language notes reach EVERY agent (right-card finding 3d) ──────────────────────────────────────
// Their bug: only the primary agent read the language signal, so the other three silently answered a
// Hindi user in English. credix delegates from master to workers, so all three must carry it.
describe('language note is applied per request, on every agent', () => {
  for (const { agent, name } of all) {
    it(`${name} appends the Hinglish note when requestContext says hinglish`, () => {
      const en = resolveInstructions(agent, 'en')
      const hinglish = resolveInstructions(agent, 'hinglish')
      expect(en).not.toContain('code-switching')
      expect(hinglish).toContain('code-switching')
      // the persona and addendum survive underneath the note
      expect(hinglish).toContain('Rahul')
      expect(hinglish.length).toBeGreaterThan(en.length)
    })

    it(`${name} is unchanged for an English user and for a missing language key`, () => {
      expect(resolveInstructions(agent, undefined)).toBe(resolveInstructions(agent, 'en'))
    })
  }
})

// ── CRITICAL block invariants (A2/A3 of the prompt incorporation plan) ────────────────────────────
// right-card's 5ab422f was them repairing exactly this: rules that drifted out of an instruction set
// nobody was asserting on. Each line below maps to a flag count in scratchpad/battery-base0804.jsonl,
// so if one silently disappears, the defect it fixes comes back unnoticed.
describe('persona CRITICAL block is present on every agent', () => {
  const MUST_CONTAIN = [
    'Never announce or narrate what you are about to do',   // announce-tool, 10 of 45
    'One reply per turn, in one voice',                      // glued-text, 16 of 45
    'Digits only, never spelled-out numbers',                // spelled-number
    'Never use a dash as punctuation',                       // dash
    'Never invent a number',
    // The strict version. This lived only on creditCardAgent, so master and credix carried the weaker
    // "or in a tool result", which an EARLIER turn's result satisfies. Asserted on all three agents now.
    'must come from a tool result in THIS turn',
    'The one exception is a figure the USER told you about themselves',
    'At most 120 words',                                     // over-length, 6 of 45
  ]
  for (const { agent, name } of all) {
    for (const line of MUST_CONTAIN) {
      it(`${name} carries: ${line.slice(0, 42)}`, () => {
        expect(resolveInstructions(agent)).toContain(line)
      })
    }
  }
})

describe('master synthesis rules (the endemic glued-text defect)', () => {
  const instr = () => resolveInstructions(masterAgent as any)
  it('forbids narrating the plan before answering', () => {
    expect(instr()).toContain('Start with the answer')
  })
  it('requires rewriting worker output rather than appending it', () => {
    expect(instr()).toContain('REWRITE what the workers give you')
  })
  it('handles a compound ask by answering the primary and offering the second', () => {
    expect(instr()).toContain('answer the PRIMARY one fully')
  })
  it('forbids introducing a figure the workers did not return', () => {
    // The master merges worker output and carries its own exaSearch, so it is the one agent that can add a
    // number during synthesis rather than while calling a tool.
    expect(instr()).toContain('Every figure in your reply must have come back from a worker or a tool on THIS turn')
  })
})
