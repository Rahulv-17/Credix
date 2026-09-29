# Cred Incorporation, Sequenced By Dependency, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fold Cred's credit-card depth into Credix's existing `creditCardAgent` as tools plus one card-catalog data layer, ordered strictly by dependency so the zero-infrastructure work ships first and the catalog-backed work is gated behind an explicit data-layer decision.

**Architecture:** Credix's node pipeline is frozen (see [credix-nodes.md](../../architecture/credix-nodes.md)). Every Cred capability arrives as a Mastra tool on the one existing `creditCardAgent`; reference data arrives as a data layer read through those tools, mirroring the bureau sidecar. No new workflow node, no new agent. This plan is the *execution ordering* of the architecture blueprint in [cred-credix-integration.md](../../architecture/cred-credix-integration.md) and [2026-07-10-cred-into-credix.md](2026-07-10-cred-into-credix.md); read those first for the "why".

**Tech Stack:** TypeScript, Mastra (`@mastra/core`), Zod, Bun test runner, OpenTelemetry (`lib/otel`), xAI Grok provider. The app lives in `src/mastra/` with its own `package.json`; the gate is `bunx tsc --noEmit` + `bun test` run from that directory.

## Global Constraints

- **No new workflow node and no new agent.** Only `creditCardAgent` is edited; only `src/mastra/tools/` and `src/mastra/lib/` gain files. `src/mastra/steps/` and the workflow definition do not change. (blueprint §8, §9)
- **Credix tool conventions, not Cred's.** New tools use `createTool` from `@mastra/core/tools`; fail-soft (return `{ ok: false, message }` or `{ available: false }`, never throw on an expected miss); PII-safe spans via `tracer.startActiveSpan` from `../lib/otel` recording counts/outcomes only, never raw score/income/PAN/mobile.
- **`user_id` is a tool input field, from trusted context.** Credix's existing tools (`signals.ts`, `bureau.ts`) take `user_id` in `inputSchema`; the workflow supplies it from init data, the model echoes it from the prompt. Follow this, NOT Cred's `requestContext.pid`/`getPid()` pattern. (deviation from blueprint §5 prose; Credix's wiring wins.)
- **Drop Cred tool scaffolding that does not fit Credix:** `makeProgress`/`writer.custom` (playground-only), `lib/card-web-fallback.ts` (use Credix's `exaSearch` instead), and `getPid`/`tool-context.ts`. `toModelOutput` is optional; prefer returning structured data the agent narrates.
- **Persona invariants stay:** max 120 words, digits-only numbers with ₹ Indian grouping, no dashes as punctuation anywhere, never emit PAN/Aadhaar/full mobile. (`agents/persona.ts`)
- **Reward/ranking math is the product; never reimplement it in TS.** `catalog.rank_cards_for_spend` and `usr.eligible_cards` move as SQL (`filtering/schema/eligible_cards.sql`, 29 KB, migrations-deep). (blueprint §7, plan §11)
- **Git:** conventional commit `scope: title; reason`; scope for this work is `agents` (Wave 1) / `api` or `infra` (Wave 2 data layer) / `agents` (Wave 2 tools). No dashes as separators in commit content. Run `verify` (here: `bunx tsc --noEmit` + `bun test` in `src/mastra/`) before each commit.

---

## Dependency Map (why the ordering is what it is)

Everything Cred adds sorts into exactly three dependency tiers:

```
TIER 0  no catalog, no decision           -> WAVE 1 (this plan, detailed)
        creditCardAgent instructions using ONLY tools that already exist
        (getBureauDetail, getSignals, checkCardEligibility, exaSearch, getStatement)
        + the bureau-report-summary behaviour (user's own score/report)

TIER 1  needs catalog DATA (reads only)   -> WAVE 2B / 2C (gated)
        getCardDetails, getCardFees, getCardBenefits, getCardCriteria,
        getCardEarnRate, getCardPartnerRates, compareCards, routeSpend

TIER 2  needs live ranking SQL + spend    -> WAVE 2D (gated, highest dependency)
        recommendCard, explainEligibilityFunnel, conversational spend capture,
        bureau-eligibility-check + bureau-eligible-cards (need per-card criteria)
```

The single root dependency for Tiers 1 and 2 is the **card catalog data layer**, which is itself
gated on three product/architecture decisions (see "Wave 2 Gate"). That is exactly why Wave 1 is
kept free of it: it ships value today with no decision pending. Wave 2 is sketched here and gets its
own bite-sized plan once the gate decisions are made ("then we will plan the ones with proper
dependencies").

Already done, do not redo (verified in source): `exaSearch`, `checkCardEligibility`, `getSignals`,
`getStatement`, `getBureauDetail` are already attached to `creditCardAgent`
([agents/credit-card.ts](../../src/mastra/agents/credit-card.ts):19). Cred's `get-user-profile` and
`exa-search` are already covered by these. (blueprint §4, §5)

---

## WAVE 1: Tier 0, zero catalog dependency (detailed, ship now)

Wave 1 is deliberately one focused commit. Everything heavier genuinely depends on the catalog, so
Wave 1 does the one thing that needs nothing new: give `creditCardAgent` real credit-card discipline
and the "your own report" behaviour, using only tools it already has. It is safe, testable, and
unblocks nothing else (so it can land in parallel with Wave 2 planning).

### Task 1: Credit-card domain instruction addendum

**Files:**
- Create: `src/mastra/agents/credit-card-instructions.ts`
- Modify: `src/mastra/agents/credit-card.ts:13-21` (compose instructions; tool set unchanged)
- Test: `src/mastra/__tests__/agents.test.ts` (add a focused `describe`)

**Interfaces:**
- Produces: `export const CREDIT_CARD_ADDENDUM: string`, a static instruction block appended after `RAHUL_PERSONA`. Consumed only by `credit-card.ts`.
- Consumes: `RAHUL_PERSONA` from `./persona` (unchanged).

**Why this is safe and not premature:** the addendum references only capabilities that exist today.
It establishes the "never state a card's fee/reward/eligibility from memory" discipline using
`exaSearch` as the sourced fallback. Wave 2E later edits this same file to insert "consult the
catalog tools first, fall back to `exaSearch` only when the catalog is silent" once those tools
exist. No forward reference to a tool that does not yet exist.

- [ ] **Step 1: Write the failing test**

Add to `src/mastra/__tests__/agents.test.ts` (the file already imports the mocked agent barrel, so the
stub captures `config.instructions`):

```ts
describe('creditCardAgent domain instructions', () => {
  const instr = (creditCardAgent as any).config.instructions as string

  it('still carries the shared Rahul persona', () => {
    expect(instr).toContain('You are Rahul')
    expect(instr).toContain('Maximum 120 words')
  })

  it('adds the card-fact sourcing discipline (no fabricated card facts)', () => {
    // never invent fees/rewards/eligibility; use a sourced tool instead
    expect(instr).toMatch(/never (state|invent|make up).*(fee|reward|eligib)/i)
    expect(instr).toContain('exaSearch')
  })

  it('adds the own-report behaviour (score/report from bureau + signals, PII-safe)', () => {
    expect(instr).toContain('getSignals')
    expect(instr).toContain('getBureauDetail')
    expect(instr).toMatch(/PAN|Aadhaar/) // reaffirms never exposing identifiers
  })

  it('leaves the tool set unchanged (no catalog tools yet)', () => {
    expect(Object.keys((creditCardAgent as any).config.tools ?? {}).sort()).toEqual(
      ['checkCardEligibility', 'exaSearch', 'getBureauDetail', 'getSignals', 'getStatement'].sort(),
    )
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src/mastra && bun test __tests__/agents.test.ts`
Expected: FAIL, the new `describe` fails because `creditCardAgent.config.instructions` is currently exactly `RAHUL_PERSONA` (no card-fact / own-report language).

- [ ] **Step 3: Create the addendum**

Create `src/mastra/agents/credit-card-instructions.ts`:

```ts
/**
 * Credit-card domain addendum, appended to RAHUL_PERSONA on creditCardAgent only.
 *
 * WAVE 1: references only tools that already exist (getBureauDetail, getSignals,
 * checkCardEligibility, exaSearch). WAVE 2E edits this file to prefer the catalog
 * tools first and fall back to exaSearch only when the catalog is silent.
 */
export const CREDIT_CARD_ADDENDUM = `
You are the credit card specialist. Two hard rules on top of your persona:

1. Card facts must be sourced, never remembered. Never state a card's fee, reward rate,
   welcome benefit, lounge access, or eligibility from memory. If a specific card fact is
   asked for, look it up with exaSearch and answer from the result, or say plainly that you
   could not verify it. It is better to say you are not sure than to guess a number.

2. Speak to approval odds, not just facts. When someone asks whether they qualify, read their
   masked profile and getSignals, use checkCardEligibility to place them in a tier, and explain
   the odds in plain words. If a card is invite-only or no longer accepting new applications,
   say so plainly and never imply they can apply.

When the user asks about their own credit report or score, summarise from the masked profile in
the message and getSignals (section 'compose'); use getBureauDetail only for a section the summary
lacks. Never read out PAN, Aadhaar, or a full mobile number, even if a tool returns one.
`.trim()
```

- [ ] **Step 4: Compose it into the agent**

Modify `src/mastra/agents/credit-card.ts`. Add the import and change the `instructions` field:

```ts
import { RAHUL_PERSONA } from './persona'
import { CREDIT_CARD_ADDENDUM } from './credit-card-instructions'
// ...
export const creditCardAgent = new Agent({
  id: 'credit-card-agent',
  name: 'CreditCard',
  description: 'Advises on credit card eligibility and options',
  instructions: `${RAHUL_PERSONA}\n\n${CREDIT_CARD_ADDENDUM}`,
  model: grokModel,
  tools: { getBureauDetail, checkCardEligibility, exaSearch, getStatement, getSignals },
  memory: credixMemory,
})
```

- [ ] **Step 5: Run the full gate**

Run: `cd src/mastra && bunx tsc --noEmit && bun test`
Expected: PASS, the new `describe` is green and no existing test (esp. `agents.test.ts` tool-set smoke, `workflow.test.ts`, `e2e.test.ts`) regressed.

- [ ] **Step 6: Commit**

```bash
git add src/mastra/agents/credit-card-instructions.ts src/mastra/agents/credit-card.ts src/mastra/__tests__/agents.test.ts
git commit -m "agents: give creditCardAgent card-fact + own-report discipline; sourced facts, approval-odds framing"
```

Then, in the same turn (session-persistence standing rule): append this task to `tasks/progress.md`,
flip its status in `tasks/todo.md`, and add any correction to `tasks/lessons.md`.

---

## WAVE 2: Tiers 1 and 2, catalog-backed (gated; plan in detail after the gate)

Wave 2 is intentionally NOT broken into bite-sized steps yet. It cannot be, honestly, until the
three gate decisions below are made, because they change the file layout of every task in it.

### Wave 2 Gate: three decisions to make before detailing Wave 2

1. **Catalog hosting.** (a) Credix-owned Postgres seeded from Cred's schema+data
   (`filtering/schema/catalog.sql` + `filtering/sources/*`), (b) reuse Cred's existing Supabase, or
   (c) a static JSON snapshot bundled in the repo. Recommendation: (a) for the reads and ranking, so
   the two products share no runtime dependency and the SQL functions move intact. (c) only works for
   Tier-1 reads, never for Tier-2 ranking (the SQL cannot run against a JSON blob), so choosing (c)
   splits the catalog in two and is not recommended. (blueprint §11.1, plan §9.2)
2. **Catalog access shape.** (a) read endpoints on a small catalog service + a `lib/catalog-fetch.ts`
   client (mirrors `lib/bureau-fetch.ts`, keeps the pipeline DB-unaware), or (b) a direct `pg` Pool in
   the tools (Cred's `lib/db.ts`). Recommendation: (a). (blueprint §11.2, plan §9.1)
3. **Spend capture** for `recommendCard`. (a) conversational-only: the agent asks for the few
   relevant categories and passes them to the ranking function per turn, or (b) persist per `user_id`.
   Recommendation: (a) first; (b) is additive later and still not a node. (blueprint §7, plan §8)

UI-driving tools (`show-*`, `recommended-card-ui`, `ui-cards`) are already decided: **deferred** to a
separate interface track, never a pipeline node. (blueprint §6, plan §6, §10 deferred track)

### Wave 2 phase sketch (each phase = one commit, pipeline stays green)

- **Phase 2A: Catalog data layer (the root dependency).** Per decisions 1+2: stand up the catalog
  (tables `card`, `card_category`, `spend_category`, `card_lounge`, `card_benefit`, `card_partner`)
  and move the two SQL functions intact; add the access client (`lib/catalog-fetch.ts`) or pool. Prove
  it with a direct query outside the agent before any tool work. Card reference data is public, so it
  does NOT pass the PII firewall. (plan §7, Phase 0)
- **Phase 2B: Catalog read tools (Tier 1a).** Port `getCardDetails`, `getCardFees`,
  `getCardBenefits`, `getCardCriteria` to `src/mastra/tools/`, each fail-soft with a PII-safe span,
  attach to `creditCardAgent`, unit-test against a mocked catalog client (mirror the `agent-mock.ts` /
  `exa-mock.ts` shared-factory pattern; see lessons.md on memoised-singleton mocking). (plan Phase 1)
- **Phase 2C: Math and comparison tools (Tier 1b).** Port `getCardEarnRate`, `getCardPartnerRates`,
  `compareCards`, `routeSpend` (catalog reads + pure math; highly testable). (plan Phase 2)
- **Phase 2D: Recommendation, funnel, eligibility rewire (Tier 2).** Port `recommendCard` (calls
  `catalog.rank_cards_for_spend` / `usr.eligible_cards`) and `explainEligibilityFunnel`; implement
  conversational spend capture (decision 3a); rewire `bureau-eligibility-check` and
  `bureau-eligible-cards` onto Credix's bureau + signals + the new `getCardCriteria`, feeding the
  existing `checkCardEligibility`. This phase delivers Cred's core value. (plan Phase 3)
- **Phase 2E: Instructions + verification.** Edit `credit-card-instructions.ts` to prefer catalog
  tools first and fall back to `exaSearch` only when the catalog is silent (Cred's hard rule). Run the
  full verify suite and an end-to-end credit-card turn through the real pipeline against a mocked
  catalog, and assert the pipeline shape is unchanged (no new node, one branch target). (plan Phase 4, 5)
- **Deferred track (out of pipeline):** interactive UI cards; persisted spend. (plan Deferred)

---

## Self-Review

- **Spec coverage:** Wave 1 covers the only Tier-0 items (instruction discipline + own-report, which
  is Cred's `bureau-report-summary` reduced to existing tools). Wave 2 phases map 1:1 to the blueprint
  §5 incorporate list and plan §10 phases; the 3 bureau rewires and the 4 UI defers are placed. The 10
  incorporate tools + 1 optional (`catalog-query`, fold-in) all appear in 2B/2C/2D. No incorporate tool
  is dropped.
- **Placeholder scan:** Wave 1 steps contain the actual addendum text, the actual edit, and runnable
  commands. Wave 2 is a *sketch by design* (user deferred it: "then we will plan the ones with proper
  dependencies") and is explicitly gated, not a hidden TODO.
- **Type consistency:** Wave 1 introduces one symbol, `CREDIT_CARD_ADDENDUM: string`, produced in
  `credit-card-instructions.ts` and consumed in `credit-card.ts`; names match. The tool-set assertion
  lists exactly the five tools in `credit-card.ts:19`, unchanged.
- **Convention check:** matches `score-improvement.ts`/`credit-card.ts` structure, `agents.test.ts`
  mock-harness usage, and the fail-soft + PII-safe-span conventions in `signals.ts`/`bureau.ts`.
