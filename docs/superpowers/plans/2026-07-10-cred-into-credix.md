# Plan: Incorporating Cred/ Flows into Credix/

*An implementation plan for folding the Cred credit-card recommendation system into the Credix
runtime. The governing rule is architectural: Credix's node pipeline does not change. Cred's
capabilities arrive as tools on the existing credit-card agent, plus one shared data layer. Nothing
from Cred becomes a new node in the Credix workflow.*

Status: proposed (2026-07-10). Prerequisite reading: [credix-nodes.md](../../architecture/credix-nodes.md)
for the node pipeline, and [signal-engine.md](../../architecture/signal-engine.md) for the signals layer.

---

## 1. Why This Plan Exists

Cred (the `Cred/` repository) is a standalone credit-card recommendation product built on
Mastra. It has its own proxy, its own five agents, roughly eighteen tools, its own Postgres card
catalog with an eligibility SQL engine, and its own auth, memory, and chat UI. Credix is the
umbrella financial credix, with a fixed node pipeline and a credit-card specialist that today is
a thin agent.

The goal is to give Credix's credit-card specialist the full depth of Cred (card catalog lookups,
reward math, eligibility assessment, personalised recommendation) without disturbing Credix's
architecture. The hard constraint, taken directly from the request and from the node diagram in
[credix-nodes.md](../../architecture/credix-nodes.md), is that we do not add nodes. Credix
already has the nodes it needs: an intent classifier, a branch, a credit-card agent, guardrails, and
compose. Cred's equivalent of those stages is therefore redundant and must not be re-created.

---

## 2. The Governing Principle

Cred and Credix solve two different layers of the same problem, and they overlap heavily at the
orchestration layer. The integration works by keeping Credix's orchestration and importing only
Cred's domain depth.

- **Orchestration (routing, intent, memory, delivery): already exists in Credix. Do not import
  Cred's version.**
- **Domain capability (what a credit-card answer actually needs: catalog facts, reward math,
  eligibility rules, ranking): import as tools on the credit-card agent.**
- **Reference data (the card catalog and the ranking SQL): import as a data layer behind those
  tools, following the same pattern Credix already uses for the bureau sidecar.**

A useful way to hold it in mind: in Cred, each capability is reached by the proxy routing to a
different agent. In Credix, the single credit-card agent reaches each capability by calling a
different tool. The routing that Cred does with nodes, Credix does with tool selection inside one
agent. That is the whole translation.

---

## 3. What Cred Contains (so the mapping is grounded)

- **A proxy pipeline** (Express): regex intent detection over 18 intents, an `intentAgent` LLM
  fallback for low-confidence messages, skill routing (`resolveSkill`), profile injection into
  specialist prompts, SSE stream translation, and a fire-and-forget background profile-sync.
- **Five Mastra agents:** `researchAgent` (the primary advisor and interview flow), `eligibilityAgent`
  (approval assessment), `calculatorAgent` (reward math), `generalCreditAgent` (credit education),
  and `intentAgent` (pure classifier).
- **Roughly eighteen tools** under `agent/src/mastra/tools/`: catalog reads (`get-card-details`,
  `card-fees`, `card-benefits`, `card-earn-rate`, `card-partner-rates`, `get-card-criteria`,
  `card-compare`, `catalog-query`), recommendation and eligibility (`recommend-card`,
  `filter-funnel`, `spend-router`, `bureau-eligibility-check`, `bureau-eligible-cards`,
  `bureau-report-summary`), web fallback (`exa-search`), and UI-driving tools (`ui-cards`,
  `recommended-card-ui`: the category picker, spend input, amount input, and recommended-card view).
- **A filtering backend** (`filtering/`): Supabase Postgres with a `catalog` schema (card,
  card_category, spend_category, card_lounge, card_benefit, card_partner) and a `usr` schema
  (user_profile, user_spend), plus the eligibility engine in `filtering/schema/eligible_cards.sql`
  (`usr.eligible_cards(pid)` and `catalog.rank_cards_for_spend(income, spend_jsonb, employment_type)`),
  and an admin console.
- **Its own identity, memory, and UI:** Firebase phone OTP, sessions keyed by a phone-derived
  `resource`, libSQL working memory with a `userProfileSchema`, and client-side threads.

---

## 4. What Stays In The Same Architecture (unchanged)

These are Credix pieces that already do the job Cred does elsewhere. They stay exactly as they
are; Cred's counterparts are discarded, not merged.

- **The node pipeline.** Decode, Pre-Guardrail, Understand, the branch, Post-Guardrail, Memory
  Writeback, and Compose are untouched. See [credix-nodes.md](../../architecture/credix-nodes.md).
- **Intent classification and routing.** The Understand node already classifies `credit_card` and the
  branch already routes it to the credit-card agent
  ([credix-workflow.ts:219](../../src/mastra/workflows/credix-workflow.ts#L219)). Cred's regex
  detector, `intentAgent`, and `resolveSkill` are not brought in.
- **The credit-card agent as the single home.** Credix already has `creditCardAgent`
  ([agents/credit-card.ts](../../src/mastra/agents/credit-card.ts)). It stays the one agent for this
  domain. This is the only agent involved; we do not add Cred's four other agents.
- **The data-layer-behind-tools pattern.** Credix already fetches bureau data from a sidecar and
  reads it through tools. The card catalog will follow the same shape: a data service queried by
  tools. This pattern stays; only a new data source is added behind it.
- **Identity.** Credix's 10-digit `user_id` (a phone-derived key) is the same idea as Cred's
  phone-derived `resource`, so Credix's existing identity is reused. Cred's Firebase OTP, sessions,
  and `resource` minting are not brought in.
- **Memory.** Credix's Observational Memory ([memory-writeback](../../src/mastra/steps/memory-writeback.ts))
  stays. Cred's libSQL working memory and background profile-sync are not brought in.
- **Delivery.** The Compose node keeps formatting for web, WhatsApp, and voice. Cred's SSE-to-client
  translation and UI-card streaming are not brought in as-is (see section 6 for the UI question).
- **Persona, model provider, guardrails, and tracing.** The Rahul persona, the xAI Grok provider,
  the PII firewall, and the observability spans all stay and now cover the new tools automatically.

---

## 5. What Moves To Tools (the import surface)

Every Cred capability below becomes a Credix tool under `src/mastra/tools/`, attached to
`creditCardAgent`. The agent decides which to call; none of them is a pipeline node. Cred's tools are
already written as Mastra tools, so this is largely a port plus a rewire to Credix's conventions
(fail-soft returns, PII-safe spans, `user_id` from trusted context rather than model arguments).

| Cred tool | Credix tool | Purpose | Notes on the port |
|---|---|---|---|
| `get-card-details` | `getCardDetails` | The primary card fact source (fees, rewards, lounge, eligibility) | Query the card catalog data layer (section 7) |
| `card-fees` | `getCardFees` | Fee breakdown for a card | Catalog read |
| `card-benefits` | `getCardBenefits` | Welcome, milestone, insurance, golf benefits | Catalog read |
| `card-earn-rate` | `getCardEarnRate` | Per-transaction point and value math | Catalog read plus pure math |
| `card-partner-rates` | `getCardPartnerRates` | Merchant-specific rates, and reverse lookup | Catalog read |
| `get-card-criteria` | `getCardCriteria` | Income and score floors, NTC and invite-only flags | Feeds eligibility |
| `card-compare` | `compareCards` | Side-by-side comparison of two cards | Composed from catalog reads |
| `recommend-card` | `recommendCard` | Ranked recommendation for the user | Calls the ranking SQL (section 7) |
| `filter-funnel` | `explainEligibilityFunnel` | Why the eligible set is empty or small | Diagnostic SQL |
| `spend-router` | `routeSpend` | Best card to use at a given merchant | Catalog plus math |
| `catalog-query` | (fold into the above) | Generic catalog lookup | Prefer specific tools; port only if needed |

Existing Credix tools cover the rest, so do not duplicate them:

- **Web fallback:** reuse Credix's `exaSearch` ([tools/exa.ts](../../src/mastra/tools/exa.ts)); do
  not port Cred's `exa-search`.
- **Eligibility scoring:** Credix already has `checkCardEligibility`
  ([tools/eligibility.ts](../../src/mastra/tools/eligibility.ts)), a pure tiering rule. Keep it, and
  let `getCardCriteria` supply the per-card thresholds it compares against. Cred's
  `bureau-eligibility-check`, `bureau-eligible-cards`, and `bureau-report-summary` overlap Credix's
  bureau tools and signals; fold their useful logic into the existing bureau and signals tools rather
  than porting them whole.
- **User financial facts:** Credix's masked profile plus the signals payload (score, income
  estimates, life stage) already give the agent what Cred's `get-user-profile` provided from its `usr`
  schema. Prefer these. The one genuine gap is per-category spend (see section 8).

The five Cred agents collapse into the one credit-card agent as follows: `researchAgent` becomes the
agent's default behaviour plus the catalog and recommend tools; `eligibilityAgent` becomes the
existing eligibility tool plus `getCardCriteria`; `calculatorAgent` becomes the earn-rate and
partner-rate tools; `generalCreditAgent` maps to Credix's existing general and score-improvement
agents (credit education is already their remit), not to a new agent; `intentAgent` is dropped
because the Understand node already classifies intent.

---

## 6. What Must NOT Become A Node (and must not be imported)

This section is the explicit guardrail the request asked for. Each item below is something Cred does
as a stage or a service, and each must be kept out of the Credix pipeline so it cannot turn into a
node by accident.

- **Do not add a Cred intent-detection node.** The Understand node already classifies intent. Cred's
  regex detector and `intentAgent` are redundant. The credit-card sub-intents (reward query,
  eligibility check, comparison, features, lounge, fee, partner cashback, upgrade, portfolio) do not
  each become a node or a branch; they collapse into tool selection inside the one credit-card agent.
- **Do not add a Cred skill-routing node.** `resolveSkill` mapped intents to five agents. Credix's
  branch already routes to one agent, and the agent routes to tools. No second router.
- **Do not add a profile-injection node.** Credix already injects the masked profile and the
  signal summary into the agent prompt ([credix-workflow.ts:101](../../src/mastra/workflows/credix-workflow.ts#L101)).
  Cred's working-memory injection is replaced by this existing behaviour.
- **Do not add a profile-sync node.** Cred's background profile-sync writes learned facts to working
  memory after each turn. Credix already has Memory Writeback driving Observational Memory. Do not
  add a second memory writer.
- **Do not import Cred's proxy or SSE translation.** Credix's boundary
  ([server.ts](../../src/mastra/server.ts)) and Compose node own request handling and delivery. The
  Express proxy and the SSE-to-xAI translation layer are not brought in.
- **Do not import Cred's auth.** No Firebase OTP, no sessions table, no `resource` minting. Credix
  identity stands.
- **Do not import Cred's threads or its libSQL memory store.** Credix memory stands.
- **Do not add the four extra agents as nodes or branches.** Only the existing credit-card agent is
  involved. Adding research, eligibility, calculator, or general-credit agents as new branch targets
  would be adding nodes, which is exactly what is disallowed.
- **UI-driving tools are a deferred decision, not a node.** Cred's category picker, spend input,
  amount input, and recommended-card view stream interactive UI cards to a bespoke frontend. Credix
  delivers composed text over three channels and has no UI-card streaming. For the first cut, the
  recommendation tools return structured data that the agent narrates as text, which fits Compose
  unchanged. Interactive UI cards, if wanted later, are a frontend and delivery concern handled
  outside the node pipeline; they are never a workflow node.

---

## 7. The Card Catalog Data Layer

Cred's card facts and ranking live in Supabase Postgres with the SQL engine in
`filtering/schema/eligible_cards.sql`. This is reference data plus deterministic ranking, and it is
the analog of Credix's bureau sidecar: a data source that tools read from.

- **Keep it as a data layer, following the existing pattern.** Stand up the card catalog as a service
  Credix can query, mirroring how the bureau sidecar is fetched today. The catalog schema
  (`card`, `card_category`, `spend_category`, `card_lounge`, `card_benefit`, `card_partner`) and the
  two SQL functions (`usr.eligible_cards`, `catalog.rank_cards_for_spend`) move over intact; the
  ranking math is the product's value and must not be reimplemented in the agent.
- **Access shape (decision in section 9).** Either expose read endpoints from a small catalog service
  and add a `lib/catalog-fetch.ts` client alongside `lib/bureau-fetch.ts`, or connect the tools to the
  Postgres pool directly with a `lib/db.ts` as Cred does. The endpoint approach matches Credix's
  current sidecar posture and keeps the pipeline unaware of the database.
- **Catalog data is not per-user PII.** Card reference data is public product information, so it does
  not pass through the PII firewall. Only user-specific inputs to the ranking (income, spend) are
  sensitive, and those already have a home in the bureau and signals layers.

---

## 8. The Spend Gap

Cred's best recommendations depend on per-category monthly spend, which it collects through the
interview UI tools and stores in `usr.user_spend`. Credix's bureau profile does not contain
spend-by-category. This is the one genuine data gap and it needs a decision.

- **First cut (recommended): capture spend conversationally through a tool.** The credit-card agent
  asks for the few relevant categories in prose, passes them to `recommendCard`, which calls
  `catalog.rank_cards_for_spend` with the spend as a parameter and income from the signals layer. No
  new store, no new node, no UI dependency.
- **Later enhancement: persist spend.** If repeat recommendations should remember spend, store it
  keyed by `user_id` (the same key the catalog would use), either in the catalog service's `usr`
  schema or in Credix's memory. This is additive and still not a node.

---

## 9. Open Decisions

1. **Catalog access:** read endpoints plus a fetch client (matches the bureau sidecar pattern), or a
   direct Postgres pool in the tools (matches Cred). Recommendation: endpoints plus a client, for
   consistency and to keep the pipeline database-unaware.
2. **Catalog hosting:** reuse Cred's existing Supabase project, or provision a Credix-owned catalog
   database seeded from Cred's schema and data. Recommendation: Credix-owned, so the two products
   do not share a runtime dependency.
3. **Spend capture:** conversational-only for the first cut, or persisted from the start.
   Recommendation: conversational-only first (section 8).
4. **UI cards:** text-narrated recommendations only, or a later frontend track for interactive cards.
   Recommendation: text first; treat interactive cards as a separate, out-of-pipeline effort.

---

## 10. Phased Implementation

Each phase is independently shippable and keeps the pipeline green. One commit per phase.

- **Phase 0: Catalog data layer.** Stand up the card catalog (schema, the two SQL functions, seed
  data) as a Credix-owned service, and add the access client per decision 1. Verify with a direct
  query outside the agent. No agent or tool changes yet.
- **Phase 1: Catalog read tools.** Port `getCardDetails`, `getCardFees`, `getCardBenefits`,
  `getCardCriteria` to `src/mastra/tools/`, each fail-soft with a PII-safe span, and attach them to
  `creditCardAgent`. Cover with unit tests against a mocked catalog.
- **Phase 2: Math and comparison tools.** Port `getCardEarnRate`, `getCardPartnerRates`,
  `compareCards`, and `routeSpend`. These are catalog reads plus pure math, so they are highly
  testable.
- **Phase 3: Recommendation and eligibility.** Port `recommendCard` (calling the ranking SQL) and
  `explainEligibilityFunnel`, and wire `getCardCriteria` into the existing `checkCardEligibility`
  flow. Implement conversational spend capture (section 8). This is the phase that delivers the core
  Cred value.
- **Phase 4: Persona and instructions.** Extend the credit-card agent's instructions so it uses the
  catalog tools first and only falls back to `exaSearch` when the catalog is silent, mirroring Cred's
  hard rule that card facts always come from tools, never from model memory. Keep the Rahul persona,
  the 120-word limit, digit-only numbers, and the no-dashes rule.
- **Phase 5: Verification.** Run the full verify suite, add an end-to-end test that drives a
  credit-card turn through the real pipeline against a mocked catalog, and confirm the pipeline shape
  is unchanged (no new nodes, one branch target).
- **Deferred (separate track, out of pipeline):** interactive UI cards, and persisted spend, if and
  when wanted.

---

## 11. Risks And Mitigations

- **Scope creep into nodes.** The main risk is that a Cred stage feels like it deserves a node.
  Mitigation: section 6 is the checklist; anything on it is a tool or is dropped, never a node.
- **Duplicated capability.** Cred and Credix both have exa search, eligibility scoring, and a
  bureau notion. Mitigation: reuse Credix's versions; port only the genuinely new catalog and
  ranking tools.
- **Ranking correctness.** The recommendation math is the product. Mitigation: move the SQL functions
  intact and test the ranking outputs against known Cred results before trusting them.
- **Latency.** Adding catalog calls inside the agent's bounded tool loop could slow the turn.
  Mitigation: the agent already runs at most three tool steps; keep catalog reads fast and cache card
  reference data, which is stable.

---

## 12. Summary

Credix keeps its pipeline; Cred brings its depth. The credit-card agent, which already exists as a
branch target, becomes the single home for the credit-card domain. Cred's catalog, reward math,
eligibility, and recommendation logic arrive as tools on that agent, backed by the card catalog data
layer reached the same way the bureau sidecar is reached today. Cred's orchestration, its four extra
agents, its auth, its memory, its proxy, and its UI streaming are not imported, because Credix
already owns those responsibilities. No new node is added to the workflow.
