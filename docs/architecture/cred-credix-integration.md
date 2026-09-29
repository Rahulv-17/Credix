# Integrating Cred into Credix: System and File-Level Blueprint

*A structured blueprint for folding the Cred credit-card recommendation system into the Credix
runtime. It states the guiding principle, then lists at the file level what is shared between the two
systems and reused, what is brought across, and what is deliberately left behind. The Credix node
pipeline does not change; Cred adapts into it.*

Credix pipeline reference: [credix-nodes.md](credix-nodes.md). Phased build detail:
[../superpowers/plans/2026-07-10-cred-into-credix.md](../superpowers/plans/2026-07-10-cred-into-credix.md).

---

## 1. Overview

Credix is the umbrella financial credix. It runs a fixed pipeline of stages, called nodes, that
take a user message, understand it, route it to one specialist, and return a safe, formatted reply.
One of those specialists is a credit-card agent, which today is thin.

Cred is a separate, mature product focused only on credit cards. It can look up verified card facts,
calculate rewards, assess approval odds, and recommend the best card for a person's spending, all
backed by a curated card catalog and a ranking engine.

The objective is to give Credix's credit-card specialist the full depth of Cred, while leaving
Credix's architecture untouched. In practice this means Cred's capabilities arrive as tools on the
existing credit-card agent, plus one shared card-catalog data layer. Nothing from Cred becomes a new
stage in the Credix pipeline.

---

## 2. The Two Systems In Brief

**Credix** owns the conversation. It has a boundary that verifies identity and fetches the user's
credit-bureau profile once, then a pipeline that decodes the message, screens it for safety,
classifies its intent, routes it to one of four specialists, scrubs the reply, updates memory, and
formats the answer for web, WhatsApp, or voice. It already has a credit-card specialist, a bureau
data service, a signals engine, and a memory system.

**Cred** owns credit-card depth. A front proxy detects intent and routes to one of five agents. Those
agents call a large family of tools that read a verified card catalog, compute reward math, and rank
cards for a user. A separate database holds the catalog and the ranking logic. Cred also carries its
own sign-in, its own memory, and its own chat interface.

The two systems overlap almost entirely on orchestration and differ mainly in credit-card depth. The
integration keeps Credix's orchestration and imports only Cred's depth.

---

## 3. The Guiding Principle

- **Orchestration stays with Credix.** Intent detection, routing, memory, safety, and delivery all
  already exist as Credix nodes. Cred's equivalents are not imported.
- **Depth comes from Cred as tools.** Each Cred capability becomes a tool on Credix's existing
  credit-card agent. The agent chooses which tool to call; no capability becomes a pipeline stage.
- **Reference data comes from Cred as a data layer.** The card catalog and its ranking logic move
  across as a data service that the new tools read from, following the exact pattern Credix already
  uses for its bureau data service.

In short: where Cred routes to a different agent, Credix selects a different tool inside one agent.
That single substitution is the whole integration.

---

## 4. Files And Capabilities That Are The Same (reuse Credix's)

Both systems independently built several of the same things. In every case below, Credix's version
is kept and Cred's is either dropped or rewired to point at Credix's version. This avoids running
two of anything.

| Capability | Cred file | Credix file (kept) | Verdict |
|---|---|---|---|
| Intent classification | `lib/intent.ts`, `agents/intent-agent.ts` | [steps/understand.ts](../../src/mastra/steps/understand.ts) | Drop Cred's; Understand already classifies intent |
| Skill routing | proxy `resolveSkill` | branch in [credix-workflow.ts](../../src/mastra/workflows/credix-workflow.ts) | Drop Cred's; the branch already routes |
| Web search | `tools/exa-search.ts` | [tools/exa.ts](../../src/mastra/tools/exa.ts) | Reuse Credix's `exaSearch` |
| Bureau access | `lib/bureau-client.ts`, `lib/bureau-store.ts` | [lib/bureau-fetch.ts](../../src/mastra/lib/bureau-fetch.ts) plus the Python sidecar | Reuse Credix's; Cred reads a different bureau source, Credix's is authoritative here |
| Model provider | `lib/model.ts` | [lib/provider.ts](../../src/mastra/lib/provider.ts) | Reuse Credix's; tools are provider-agnostic, the agent uses Credix's model |
| Language handling | `lib/language-notes.ts` | [steps/decode.ts](../../src/mastra/steps/decode.ts) | Reuse Credix's language detection |
| Conversation memory | libSQL working memory, proxy profile-sync | [memory/index.ts](../../src/mastra/memory/index.ts), [steps/memory-writeback.ts](../../src/mastra/steps/memory-writeback.ts) | Reuse Credix's memory |
| User financial facts | `tools/get-user-profile.ts` | masked profile plus [tools/signals.ts](../../src/mastra/tools/signals.ts) | Reuse Credix's; signals already carry score, income, life stage |
| Eligibility scoring | `lib/eligibility-model.ts` | [tools/eligibility.ts](../../src/mastra/tools/eligibility.ts) | Reuse Credix's tiering rule, fed by the new criteria tool |

Two points worth flagging for a reviewer. First, Cred defaults to a Google model and Credix uses
xAI Grok; because the tools do not care which model calls them, this is not a conflict, the agent
simply uses Credix's model. Second, Cred fetches bureau data from a different external provider
than Credix's warehouse-backed sidecar; Credix's is treated as the source of truth, so Cred's
bureau tools are rewired to it rather than ported.

---

## 5. Tools To Incorporate (the import surface)

Cred ships 18 tool files that export 20 individual tools. The table lists every one in plain terms,
with a verdict: Incorporate means port it into Credix as a new tool on the credit-card agent;
Reuse means Credix already has an equivalent; Defer means it belongs to a later, separate track.

| # | Tool | What it does (plain English) | Verdict |
|---|---|---|---|
| 1 | get-card-details | The primary source of truth for one card: its fees, reward rates, lounge access, and eligibility, all from the verified catalog | Incorporate |
| 2 | card-fees | The full fee breakdown for a card: joining fee, annual fee, waiver conditions, foreign-exchange markup, interest rate | Incorporate |
| 3 | card-benefits | A card's welcome, milestone, insurance, golf, dining, and concierge benefits | Incorporate |
| 4 | card-earn-rate | How many reward points, and how much value, a card earns for a specific spend at a specific merchant | Incorporate |
| 5 | card-partner-rates | Merchant and brand specific earn rates for a card, and the reverse lookup of which cards reward a given merchant best | Incorporate |
| 6 | get-card-criteria | A card's eligibility thresholds: income floor, score floor, new-to-credit policy, invite-only flag | Incorporate |
| 7 | card-compare | A side-by-side comparison of two named cards across fees, rewards, and benefits | Incorporate |
| 8 | recommend-card | The best card for the user for a chosen spend category, with ranked alternatives, using the ranking engine | Incorporate |
| 9 | filter-funnel | A plain explanation of why the user does or does not qualify for cards, stage by stage | Incorporate |
| 10 | spend-router | Given the cards a user already holds and a merchant, which of their cards to use for the best return | Incorporate |
| 11 | catalog-query | A generic read-only lookup against the card catalog for facts the specific tools do not cover | Incorporate only if needed; prefer the specific tools above |
| 12 | exa-search | Live web research for card terms not in the catalog | Reuse Credix's `exaSearch` |
| 13 | get-user-profile | Load the user's income, age, employment, and score band | Reuse Credix's masked profile plus signals |
| 14 | bureau-eligibility-check | Check real eligibility for a named card against the user's actual bureau report | Reuse Credix's bureau and signals; rewire, do not port the external source |
| 15 | bureau-eligible-cards | Gate every catalog card against the user's real bureau report | Reuse Credix's bureau and signals; rewire |
| 16 | bureau-report-summary | Show the user their own score and a summary of their report | Reuse Credix's bureau and signals |
| 17 | show-category-picker | Display an interactive picker for the user to select spend categories | Defer to the interface track |
| 18 | show-spend-input | Display an interactive input for monthly spend per category | Defer to the interface track |
| 19 | show-amount-input | Display an interactive input for a single amount, for example monthly income | Defer to the interface track |
| 20 | show-recommended-card | Populate the on-screen recommended-card view | Defer to the interface track |

Summary of the verdicts: 10 tools to incorporate (numbers 1 to 10), 1 optional (number 11),
5 already covered by Credix and reused or rewired (numbers 12 to 16), and 4 interactive display
tools deferred to a separate interface effort (numbers 17 to 20).

The incorporated tools live under `src/mastra/tools/` and attach to the existing credit-card agent.
When ported they adopt Credix's conventions: they never throw, they emit privacy-safe tracing that
records counts and outcomes but never raw personal values, and they read the user identifier from
trusted request context rather than from anything the model supplies.

---

## 6. Files And Flows Deliberately Not Brought In

These belong to Cred's orchestration, sign-in, memory, and interface. Credix already owns each
responsibility, so importing Cred's version would mean running two of the same thing, and in several
cases would mean adding a stage to the pipeline, which is out of bounds.

| Cred area | Cred files | Why it is left behind |
|---|---|---|
| Front proxy and stream translation | `interface/server/*`, proxy pipeline | Credix's boundary and delivery node already do this |
| Intent detector and classifier agent | `lib/intent.ts`, `agents/intent-agent.ts` | The Understand node already classifies intent |
| Skill router | proxy `resolveSkill` | The branch already routes to one specialist |
| Background profile-sync | proxy profile-sync handler | Memory Writeback already updates memory |
| The four extra agents | `agents/research-agent.ts`, `agents/eligibility-agent.ts`, `agents/calculator-agent.ts`, `agents/general-credit-agent.ts` | They collapse into the single credit-card agent as tool behaviours; the general-credit role maps to Credix's existing general and score-improvement agents |
| Sign-in and sessions | Firebase phone auth, session store | Credix identity, the phone-derived user id, already covers this |
| Cred's own bureau source | `lib/bureau-client.ts`, `lib/bureau-store.ts` | Credix's bureau sidecar is the source of truth |
| Cred's own memory | libSQL working memory | Credix memory covers this |
| Chat interface | `interface/` | Credix has its own interface |

The four interactive display tools (numbers 17 to 20 above) are a special case. They are not
orchestration, but Credix delivers composed text over its channels and has no mechanism today for
streaming interactive cards to a screen. For the first release, the recommendation tools return
structured data that the agent narrates as text, which fits Credix's delivery node unchanged.
Interactive cards, if wanted later, are an interface concern handled outside the pipeline; they never
become a pipeline stage.

---

## 7. The Card Catalog Data Layer

Cred's card facts and its ranking logic live in a Postgres database with a dedicated ranking engine.
This is reference data plus deterministic math, and it is the direct analog of Credix's bureau data
service: a data source that tools read from, kept out of the pipeline's awareness.

- **What moves:** the catalog tables (cards, card categories, spend categories, lounge access,
  benefits, and partner rates) and the two ranking functions that turn a user's income and spending
  into a ranked list of cards. The ranking logic is the product's core value and moves across intact
  rather than being rebuilt inside the agent.
- **How it is reached:** a small catalog service exposes read endpoints, and Credix adds a catalog
  client alongside its existing bureau client. This keeps the pipeline unaware of the database, exactly
  as it is unaware of the bureau warehouse today.
- **Privacy:** card catalog data is public product information and does not pass through the personal
  data firewall. Only the user's own inputs to the ranking, namely income and spending, are sensitive,
  and those already have a home in the bureau and signals layers.

The one genuine data gap is per-category monthly spend, which Cred collected through its interactive
inputs. Credix's bureau data does not contain it. For the first release the credit-card agent asks
for the few relevant categories in conversation and passes them to the recommendation tool, so no new
store and no new stage is required. Persisting spend for repeat visits is a later, additive option.

---

## 8. The Exact Change Surface In Credix

The integration touches a deliberately small number of places, all additive.

- **New files:** the incorporated tools under `src/mastra/tools/` (numbers 1 to 10, and 11 if needed),
  and a catalog client under `src/mastra/lib/`.
- **One edited file:** [agents/credit-card.ts](../../src/mastra/agents/credit-card.ts), to attach the
  new tools and to extend its instructions so it consults the catalog first and only falls back to web
  search when the catalog is silent.
- **New service:** the card catalog data layer, standing beside the existing bureau service.
- **Rewired, not new:** the three bureau-oriented Cred tools point at Credix's bureau and signals.

Nothing else in `src/mastra/` changes. In particular, none of the files under `src/mastra/steps/`
change, and the workflow definition does not gain a stage.

---

## 9. What Does Not Change

The Credix pipeline is frozen for this work. The nodes, in order, remain identity check, bureau
fetch, signals fetch, decode, pre-guardrail, understand, the branch, post-guardrail, memory writeback,
and compose. The credit-card branch target remains a single agent. The personal-data firewall, the
single-fetch rule, the observability spans, the persona, and the delivery channels all remain exactly
as documented in [credix-nodes.md](credix-nodes.md).

---

## 10. Rollout

The work is phased so each step is independently shippable and the pipeline stays green throughout.

1. **Catalog data layer.** Stand up the catalog service with its tables, ranking functions, and seed
   data, and add the catalog client. Prove it with a direct query before any agent work.
2. **Catalog read tools.** Port the four fact tools (details, fees, benefits, criteria) and attach
   them to the credit-card agent.
3. **Math and comparison tools.** Port earn rate, partner rates, compare, and spend router.
4. **Recommendation and eligibility.** Port the recommendation and funnel tools, wire the criteria
   tool into the existing eligibility rule, and add conversational spend capture. This phase delivers
   the core value.
5. **Instructions and verification.** Extend the agent instructions to prefer catalog tools, then run
   the full verification suite and an end-to-end credit-card test, confirming the pipeline shape is
   unchanged.
6. **Deferred track.** Interactive display cards and persisted spend, handled separately from the
   pipeline if and when wanted.

---

## 11. Open Decisions

1. **Catalog hosting:** reuse Cred's existing database, or provision a Credix-owned catalog seeded
   from Cred's schema and data. Recommendation: Credix-owned, so the two products share no runtime
   dependency.
2. **Catalog access:** read endpoints plus a client, matching the bureau service pattern, or a direct
   database connection in the tools. Recommendation: endpoints plus a client, for consistency.
3. **Spend capture:** conversational only at first, or persisted from the start. Recommendation:
   conversational first.
4. **Interactive cards:** text-narrated recommendations only for now, or a parallel interface track.
   Recommendation: text first.

---

## 12. Appendix: Side-By-Side File Inventory

### Credix (kept and extended)

- **Pipeline stages** (`src/mastra/steps/`): identity-check, decode, pre-guardrail, understand,
  post-guardrail, memory-writeback, compose, user-story. Unchanged.
- **Agents** (`src/mastra/agents/`): credix, credit-card (extended), insurance, score-improvement,
  and the shared persona. No new agent.
- **Tools** (`src/mastra/tools/`): getBureauProfile and getBureauDetail, calculateEmi and
  calculateFoir, checkCardEligibility, exaSearch, getSignals, getStatement. Kept, with the new
  catalog tools added alongside.
- **Support** (`src/mastra/lib/`): bureau-fetch, user-story-fetch, signal-summary, provider, otel,
  retry, patterns, errors, http-dispatcher, normalize-user-id, statement-store, storage,
  web-grounding. A catalog client is added here.
- **Boundary and graph:** server, index, and the workflow definition. Unchanged in shape.

### Cred (source of the import)

- **Tools** (`agent/src/mastra/tools/`): the 18 files listed in section 5. Ten are incorporated, one
  is optional, three bureau tools are rewired to Credix's bureau, and four display tools are
  deferred.
- **Agents** (`agent/src/mastra/agents/`): research, eligibility, calculator, general-credit, intent.
  None imported as agents; their behaviour folds into the one credit-card agent and Credix's
  existing agents.
- **Support** (`agent/src/mastra/lib/`): bureau-client, bureau-store, cards, card-web-fallback,
  catalog-cards, db, eligibility-model, intent, language-notes, model, tool-context. Reused from
  Credix where an equivalent exists; catalog-cards and cards inform the ported catalog tools.
- **Data layer** (`filtering/`): the catalog and user schemas, the ranking engine, and the admin
  console. The catalog and ranking engine move across as the new data layer; the admin console is
  optional and separate from the pipeline.
- **Sign-in, memory, interface:** not imported.
