# Issue 006, Cred credit-card tools integration

**Jira:** [ZT-597](https://finbud.atlassian.net/browse/ZT-597)
**Epic:** [ZT-260, FRIDAY v1 Credix App](https://finbud.atlassian.net/browse/ZT-260)
**GitHub:** [financebuddha/credix#13](https://github.com/financebuddha/credix/issues/13)
**Type:** AFK
**Parent:** `tasks/todo.md` Phase 14 (Cred incorporation, sequenced by dependency)
**Plans:** `docs/superpowers/plans/2026-07-13-cred-incorporation-sequenced.md`, `docs/superpowers/plans/2026-07-10-cred-into-credix.md`
**Architecture:** `docs/architecture/cred-credix-integration.md`, `docs/architecture/credix-nodes.md`
**Goal:** give Credix's existing `creditCardAgent` the full depth of Cred (verified card catalog facts, reward math, eligibility, ranking) as tools on that one agent plus a card-catalog data layer, WITHOUT adding any workflow node or new agent.

---

## Why

Credix's credit-card specialist is thin. Cred is a mature credit-card product with a verified card catalog, reward math, and a ranking engine, but it carries its own proxy, five agents, auth, memory, and UI. We want Cred's domain depth, not its orchestration. The governing rule: Credix's node pipeline is frozen; every Cred capability arrives as a Mastra tool on the existing `creditCardAgent`, backed by a catalog data layer read the same way the bureau sidecar is read today.

**Governing principle:** where Cred routes to a different agent, Credix selects a different tool inside one agent. That single substitution is the whole integration.

---

## Status legend

`[x]` done and verified, `[~]` partial or in progress, `[ ]` not started.

---

## Scope

### In scope (To ADD)
- 10 new tool files under `src/mastra/tools/` (plus 1 optional).
- Catalog access layer under `src/mastra/lib/`.
- Card catalog data layer (catalog schema, `usr.eligible_cards`, `catalog.rank_cards_for_spend`, seed data).
- Edit `src/mastra/agents/credit-card.ts` (attach new tools, extend instructions).
- Rewire 3 bureau tools to Credix bureau plus signals.
- Conversational spend capture inside `recommendCard`.

### Out of scope, remains the same
- All pipeline nodes: identity-check, bureau fetch, signals fetch, decode, pre-guardrail, understand, branch, post-guardrail, memory-writeback, compose. Unchanged.
- The 4 agents (only `credit-card` edited; no new agent).
- The existing tools kept as-is.
- Identity (`user_id`), memory (Observational Memory), guardrails, compose channels, persona, Grok provider, tracing, PII firewall, single-fetch.

### NOT brought in
- Cred proxy, intent detector plus `intentAgent`, `resolveSkill` router, profile-sync.
- The 4 extra agents (research, eligibility, calculator, general-credit).
- Firebase auth plus sessions, Cred bureau source (`bureau-client`, `bureau-store`), Cred libSQL memory plus client threads, Cred interface.

---

## Tool inventory

Cred total: 18 tool files, 20 tools. Incorporate: 10, Optional: 1, Reuse or rewire: 5, Defer: 4. Credix existing kept: 8.

### Incorporate (10), new in Credix

| # | Cred tool | Credix tool | Data source | Status |
|---|---|---|---|---|
| 1 | get-card-details | `getCardDetails` | catalog (card plus 5 tables) | `[x]` done, live-verified |
| 2 | card-fees | `getCardFees` | catalog.card | `[x]` done, live-verified |
| 3 | card-benefits | `getCardBenefits` | card_benefit, lounge, tier, fuel | `[x]` done, live-verified |
| 4 | card-earn-rate | `getCardEarnRate` | catalog plus reward math | `[ ]` not started (43 KB, heaviest math) |
| 5 | card-partner-rates | `getCardPartnerRates` | catalog.card_partner_rate | `[x]` done, live-verified |
| 6 | get-card-criteria | `getCardCriteria` | catalog.card | `[x]` done, live-verified |
| 7 | card-compare | `compareCards` | catalog (multi-table) | `[x]` done, live-verified |
| 8 | recommend-card | `recommendCard` | ranking SQL plus spend capture | `[ ]` not started (Tier 2) |
| 9 | filter-funnel | `explainEligibilityFunnel` | diagnostic SQL over usr tables | `[ ]` not started (Tier 2, needs rewire) |
| 10 | spend-router | `routeSpend` | catalog plus math | `[ ]` not started (math) |

### Optional (1)
- `[ ]` catalog-query, port only if the 10 above miss something.

### Reuse Credix's, rewire Cred's (5)
- `[x]` exa-search, use existing `exaSearch` (already attached).
- `[x]` get-user-profile, use masked profile plus `getSignals` (already available).
- `[ ]` bureau-eligibility-check, rewire to Credix bureau plus `checkCardEligibility` plus `getCardCriteria`.
- `[ ]` bureau-eligible-cards, rewire to Credix bureau plus signals plus catalog.
- `[ ]` bureau-report-summary, rewire to Credix bureau plus signals (instruction-level, part of the addendum).

### Defer (4), interface track, never a pipeline node
- `[ ]` show-category-picker, `[ ]` show-spend-input, `[ ]` show-amount-input, `[ ]` show-recommended-card.

### Credix existing (kept)
- `getBureauProfile`, `getBureauDetail`, `calculateEmi`, `calculateFoir`, `checkCardEligibility`, `exaSearch`, `getSignals`, `getStatement`.

---

## As-built vs planned (accuracy note)

The plan proposed a Credix-owned catalog DB reached via an endpoint client (`lib/catalog-fetch.ts`). The as-built first cut took the low-friction, reversible path:

- `[x]` `src/mastra/lib/catalog-db.ts`, a lazy `pg` Pool that reuses Cred's Supabase catalog directly via `DATABASE_URL`. Null-safe (tools fail soft when unset), SSL opt-ins (`DB_SSL_CA` or `DB_SSL_VERIFY`), test seam (`resetCatalogPoolForTests`).
- `[x]` `src/mastra/lib/catalog-cards.ts`, Cred's fuzzy matcher (`cardMatchSql`, `resolveCardCandidates`, `editionAmbiguity`, `issuerMatches`) plus ranking helpers, ported; only the DB accessor swapped.
- `[ ]` `lib/catalog-fetch.ts` endpoint client plus a Credix-owned seeded DB, deferred; a later swap behind the same tools (no tool changes needed). Decision pending (see Open decisions).

`pg` added to `src/mastra/package.json`. `.env.example` documents `DATABASE_URL` and `DB_SSL_*`.

---

## Deliverables and checks

### Phase A, Catalog read tools `[x]` COMPLETE (6 of 6)
Files: `src/mastra/lib/catalog-db.ts`, `src/mastra/lib/catalog-cards.ts`, `src/mastra/tools/card-catalog.ts`, `src/mastra/agents/credit-card.ts`.

- [x] `getCardCriteria`, `getCardFees`, `getCardPartnerRates`, `getCardBenefits`, `getCardDetails`, `compareCards` ported.
- [x] Credix conventions: `createTool` plus zod; fail-soft (`{ ok:false }` or `{ found:false }`, never throw on an expected miss); PII-safe `catalog.*` spans (counts and outcomes only, never card queries); numeric-string columns coerced (`::float8` or `toNum`); on a catalog miss point the agent to `exaSearch`.
- [x] Dropped on port: Cred `makeProgress` and `writer.custom`, `card-web-fallback`, `toModelOutput`.
- [x] Attached to `creditCardAgent` (now 11 tools); `agents.test.ts` tool-set assertion updated.
- [x] Unit tests (mocked pg) in `__tests__/card-catalog.test.ts`; live tests in `__tests__/card-catalog.live.test.ts`.
- [x] Verify: `tsc` 0, `bun test` 232 pass, 22 skip, 0 fail, live smoke green.

### Phase B, Math tools `[ ]`
- [ ] `getCardEarnRate` (per-category and per-merchant reward value math; Cred `card-earn-rate.ts`, 43 KB; port the SQL plus shaping, drop the Cred UI-isms).
- [ ] `routeSpend` (given held cards plus a merchant, which card to use).
- [ ] Unit tests (mocked pg), live tool-correctness, live e2e goal.

### Phase C, Recommendation and funnel (Tier 2) `[ ]`
- [ ] `recommendCard`, call `catalog.rank_cards_for_spend(income, spend_jsonb)` with income from signals and spend captured conversationally (Credix does NOT populate `usr.user_spend`, so use the param-based ranking function, not `usr.eligible_cards(pid)`).
- [ ] `explainEligibilityFunnel`, rewire the diagnostic to signals income plus conversational spend (Cred's version reads `usr.user_profile` and `usr.user_spend`, which Credix does not fill).
- [ ] Conversational spend-capture prompt loop inside `recommendCard`.
- [ ] Unit plus live tests.

### Phase D, Bureau rewires `[ ]`
- [ ] `bureau-eligibility-check`, use Credix `getBureauDetail` or `getSignals` plus `checkCardEligibility` plus `getCardCriteria`.
- [ ] `bureau-eligible-cards`, use Credix bureau plus signals to gate over the catalog.
- [ ] `bureau-report-summary`, summarize from masked profile plus `getSignals` (instruction-level).

### Phase E, Instruction addendum (quality gate) `[ ]`
Move the narration-correctness rules dropped with Cred's `toModelOutput` into `creditCardAgent` instructions:
- [ ] Card facts are sourced, never remembered; catalog first, `exaSearch` only when the catalog is silent.
- [ ] Year-one cost is the joining fee only (the annual fee applies from renewal).
- [ ] Insurance covers are protection limits, never summed into benefit value.
- [ ] Reward maximums are "up to" (assume every milestone hit); `is_instant_discount` is not reward points.
- [ ] For a NULL field (for example a null score floor) say "not published" rather than burning a web search or re-calling the same tool (fixes the maxSteps or empty-text finding, see Testing).
- [ ] Disclose edition ambiguity (`ambiguous_with`), grandfathered or invite-only plainly.

### Phase F, Catalog data-layer decision `[ ]`
- [ ] Decide: keep reusing Cred's Supabase (current), or a Credix-owned seeded DB, or an endpoint plus `lib/catalog-fetch.ts`. Recommendation: Credix-owned DB plus client, so the two products share no runtime dependency. Reversible; no tool changes.

---

## Flow: a credit-card turn (unchanged pipeline)

1. Boundary: identity-check, produces `user_id`.
2. Boundary: bureau fetch (once).
3. Boundary: signals fetch.
4. Node: decode, produces text plus language.
5. Node: pre-guardrail, safety screen plus masked profile.
6. Node: understand, intent is `credit_card`.
7. Node: branch, routes to `creditCardAgent`.
8. Agent: reads masked profile plus signal summary from the prompt.
9. Agent to tool: `getCardDetails`, `getCardFees`, `getCardBenefits`, `getCardCriteria` (catalog facts).
10. Agent to tool: `getCardEarnRate`, `getCardPartnerRates`, `compareCards`, `routeSpend` (math, compare).
11. Agent to tool: `recommendCard` (asks spend conversationally, ranking engine, ranked cards).
12. Agent to tool: `checkCardEligibility` plus `getCardCriteria` (approval odds).
13. Agent to tool: `getSignals` or `getBureauDetail` (user facts); `exaSearch` (only if catalog silent).
14. Agent: answer text (max 3 tool steps).
15. Node: post-guardrail, scrub PAN, Aadhaar, mobile.
16. Node: memory-writeback, Observational Memory.
17. Node: compose, web, WhatsApp, or voice.
18. Boundary: reply returned.

## Data path (tools to data)

- `getCard*`, `compareCards`, `routeSpend`, catalog data layer (read).
- `recommendCard`, `explainEligibilityFunnel`, ranking engine (`catalog.rank_cards_for_spend`; NOT `usr.eligible_cards`, since Credix has no `usr` data).
- `checkCardEligibility`, pure rule (no I/O), fed by `getCardCriteria`.
- bureau and signals tools, Credix bureau sidecar plus signals store.
- `exaSearch`, live web (fallback only).

---

## Testing

Three layers. The gated live suite lives in `src/mastra/__tests__/card-catalog.live.test.ts` and is run in ISOLATION (sibling files `mock.module` pg, agent, exa for the whole process):

```
LIVE_CATALOG=true bun test --env-file=../../.env src/mastra/__tests__/card-catalog.live.test.ts --timeout 180000
```

> Note: `bun test` loads `.env` from CWD, not the repo root; live runs REQUIRE `--env-file=../../.env`.

### 1. Regression Testing
Run before every commit; nothing below may go red.

- [x] `cd src/mastra && bunx tsc --noEmit` exits 0.
- [x] `bun test` (full suite) green. Baseline this issue: 232 pass, 22 skip, 0 fail.
- [x] No new workflow node; `credit_card` remains a single branch target (workflow.test).
- [x] `agents.test.ts` tool-set assertion matches the attached tools exactly.
- [x] Card tools fail soft when `DATABASE_URL` is unset, so a fresh clone or CI without the catalog stays green (no throw at import; returns `{ ok:false, message: CATALOG_DB_UNAVAILABLE }`).
- [x] No regression in bureau, signals, understand, workflow, or e2e suites.
- [ ] Re-run after each new phase (B to E) and update the pass count here.

### 2. End-to-End Workflow Testing (Goal-based)
Drive the REAL `credixWorkflow` (understand, branch, `creditCardAgent`, post-guardrail, compose) with a synthetic bureau profile (no sidecar). Each goal asserts: correct routing, a grounded answer, PII-safe output, `degraded=false`.

| Goal (user intent) | Example message | Expected routing | Expected tool(s) | Pass criteria | Status |
|---|---|---|---|---|---|
| Know a card's cost | "annual fee plus forex on HDFC Infinia" | credit_card | getCardFees or getCardDetails | answer has fee, waiver, forex; no PAN or Aadhaar | `[x]` |
| Choose between cards | "compare HDFC Infinia and Axis Atlas" | credit_card | compareCards | both cards named with fees, lounge | `[x]` |
| Learn a card's perks | "lounge plus benefits on Axis Atlas" | credit_card | getCardBenefits | lounge visits plus welcome stated | `[x]` |
| Best card at a merchant | "best card for Amazon" | credit_card | getCardPartnerRates | names the top card plus rate | `[x]` |
| Full rundown of a card | "tell me about SBI Cashback" | credit_card | getCardDetails | fees, earn, caveats | `[x]` |
| Maximize a spend | "best card for my dining and travel spend" | credit_card | recommendCard (plus spend capture) | ranked cards from the engine | `[ ]` Phase C |
| Where to swipe now | "which of my cards for Swiggy" | credit_card | routeSpend | picks a held card plus reason | `[ ]` Phase B |
| Will I get approved | "can I get the Atlas on my profile" | credit_card | checkCardEligibility plus getCardCriteria plus getSignals | tier plus odds, grandfathered or invite-only flagged | `[ ]` Phase D or E |

- [x] PII regression inside e2e: the synthetic profile carries PAN and Aadhaar; the composed reply must contain neither (post-guardrail).
- [x] Routing regression: every card goal classifies to `credit_card`, not `general`.

### 3. Tool Correctness
Per tool, the correctness contract is: the LLM invokes it AND it returns real catalog data (not the fail-soft shape). Final answer text is a soft check (agents vary which allowed tool they pick; a turn can exhaust `maxSteps:3`).

Per-tool checklist (unit is mocked pg; live is real catalog via the agent):
- [x] `getCardCriteria`, LIKE match; income-floor column follows `employmentType`; grandfathered flag surfaces; numeric coercion; miss points to exaSearch. (unit plus live)
- [x] `getCardFees`, GST-inclusive totals; numeric-string pct parsed; edition ambiguity; miss points to exaSearch. (unit plus live)
- [x] `getCardPartnerRates`, 3 modes (card_all, partner_all, card_partner); `is_instant_discount` flagged; reverse lookup. (unit plus live)
- [x] `getCardBenefits`, lounge, fuel, network-tier synthesis; grouped; value_inr parsed. (unit plus live)
- [x] `getCardDetails`, card plus 5 parallel reads; earn rates, milestones, transfer partners plus caps; all numerics coerced. (unit plus live)
- [x] `compareCards`, 2 or 3 cards, each resolves independently; a miss gets its own error entry. (unit plus live)
- [ ] `getCardEarnRate` (Phase B), `routeSpend` (Phase B), `recommendCard` (Phase C), `explainEligibilityFunnel` (Phase C), 3 bureau rewires (Phase D).

Findings logged (behavior, not tool defects; see `tasks/lessons.md`):
- [x] A criteria question on a card with a NULL `score_floor` made the agent over-call (`getCardCriteria`, `exaSearch`, `getCardCriteria`), hit `maxSteps:3`, and returned empty final text. The tool was correct; the workflow masks empty text with a fallback. The Phase E addendum is the fix.
- [x] Live tool tests MUST use a per-run-unique memory thread, or Observational Memory answers a rerun from the prior run's memory (`tools=[]` yet still grounded).

---

## Acceptance criteria

- [x] Catalog read tier (6 tools) attached to `creditCardAgent`, unit plus live verified, pipeline green.
- [ ] Math tier (`getCardEarnRate`, `routeSpend`) attached plus tested.
- [ ] Recommendation tier (`recommendCard`, `explainEligibilityFunnel`) with conversational spend capture, attached plus tested.
- [ ] 3 bureau tools rewired onto Credix bureau plus signals.
- [ ] Instruction addendum in place; narration-correctness rules enforced.
- [ ] Catalog data-layer hosting or access decision made and, if chosen, the endpoint client landed.
- [ ] Every phase: `tsc` 0 plus full `bun test` green plus a live e2e goal plus per-tool correctness.
- [ ] No new workflow node; no new agent; only `credit-card.ts` edited among agents.

---

## Invariants carried

- Credix node pipeline is frozen; Cred capabilities are tools, never nodes.
- Card reference data is public, so it does NOT pass the PII firewall; spans record counts and outcomes only.
- `user_id` is a trusted tool-input field (Credix convention), not Cred's `requestContext.pid`.
- Reward and ranking math stays in SQL (`catalog.rank_cards_for_spend`); never reimplemented in TS.
- Persona invariants: at most 120 words, digits-only with rupee grouping, no dashes, never emit PAN, Aadhaar, or mobile.
- Tools fail soft; a catalog or DB outage degrades one answer, never 502s the turn.

---

## Open decisions

1. Catalog hosting: keep reusing Cred's Supabase (current low-friction path), or provision a Credix-owned catalog seeded from Cred's schema plus data. Recommendation: Credix-owned, so the two products share no runtime dependency.
2. Catalog access: direct `pg` Pool in a shared lib (current), or read endpoints plus `lib/catalog-fetch.ts` (matches the bureau sidecar pattern). Recommendation: endpoints plus client.
3. Spend capture for `recommendCard`: conversational-only first (recommended), or persisted per `user_id` later (additive, still not a node).
4. Interactive UI cards (the 4 deferred tools): text-narrated recommendations only for now; interactive cards are a separate interface track, never a pipeline node.
