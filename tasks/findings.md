# Findings — signal-engine integration (2026-07-09)

## Architecture as-built
- Single bureau fetch in Hono: server.ts:94 `fetchBureau(user_id)` -> profile passed into
  workflow initData.bureau_profile (server.ts:112-119), under `credix.workflow` span.
- `fetchBureau` (lib/bureau-fetch.ts) already keeps an in-process TTL Map cache keyed by
  user_id (BUREAU_CACHE_TTL_MS default 900_000, CACHE_MAX 1000) + `bureau.fetch` span with
  app.bureau.result / app.bureau.cache attrs. This is the module-cache precedent.
- Module-cache + agent-tool precedent: lib/statement-store.ts (putStatement/getStatement) +
  a Mastra tool the specialist agents call. Signals should mirror this shape.
- Tracing helpers: lib/otel.ts -> `instrumentStage(name,input,fn)` (stage.<name> span) and
  `tracer.startActiveSpan(...)`. PII rule: NO user_id/mobile/PAN/Aadhaar/CIBIL score on spans.

## Schema mismatch (decisive)
- engine_full.py consumes FLAT scrub-row keys (HL_ALL, SCORE, FOIR, <30DPD_12mon...).
- Sidecar serves CATEGORIZED doc (normalizer.py + scrub_mapping.yaml): general_info.score,
  loan_details.HL.all, dpd.buckets.lt30.m12, enquiries.totals.enq_30d, etc.
- Flat<->categorized map is deterministic/mechanical (adapter feasible).

## PII constraint (decisive)
- `/internal/bureau/{id}` returns strip_secure(doc): the `pii` section (secure:true) is DROPPED.
  TS runtime NEVER sees PAN/DOB/name/phones/addresses.
- => Engine's PII-derived signals cannot be computed in TS from the fetched profile:
  ~14 Tier-1 vars + ~10 Tier-2 (all age/PAN/passport-derived). Full compute requires the
  flat row incl. PII, which only exists inside the Python sidecar.

## 2026-07-10: Cred/ architecture map (for the integration plan)

Source: Cred repo docs part1-4 (auth, chat lifecycle, agent tools, agents+engine) + agent/src +
filtering/. Cred = standalone credit-card recommendation product on Mastra.

- Proxy pipeline (Express): regex intent detect (18 intents) -> intentAgent LLM fallback ->
  resolveSkill -> profile injection -> forward to Mastra agent -> SSE translate -> bg profile-sync.
- 5 agents: researchAgent (primary + interview), eligibilityAgent, calculatorAgent,
  generalCreditAgent, intentAgent (classifier).
- ~18 tools (agent/src/mastra/tools/): get-card-details, card-fees, card-benefits, card-earn-rate,
  card-partner-rates, get-card-criteria, card-compare, catalog-query, recommend-card, filter-funnel,
  spend-router, bureau-eligibility-check, bureau-eligible-cards, bureau-report-summary, exa-search,
  ui-cards + recommended-card-ui (category-picker, spend-input, amount-input, recommended-card).
- Data layer: Supabase Postgres. catalog schema (card, card_category, spend_category, card_lounge,
  card_benefit, card_partner) + usr schema (user_profile, user_spend). Eligibility engine:
  filtering/schema/eligible_cards.sql -> usr.eligible_cards(pid),
  catalog.rank_cards_for_spend(income, spend_jsonb, employment_type). Ranking = the product value.
- Own identity (Firebase OTP, sessions, phone-derived `resource`), own libSQL working memory
  (userProfileSchema), own client threads, own chat UI.

Key alignments with Credix:
- Cred `resource` (phone-derived) == Credix `user_id` (10-digit mobile). Same key idea.
- Both on xAI Grok (Cred grok-4.3; Credix grok-3, env-tunable).
- Credix ALREADY has creditCardAgent + checkCardEligibility + exaSearch + getSignals. So the
  integration is: attach Cred's catalog/reward/recommend tools to the existing creditCardAgent;
  reuse exa + eligibility + bureau/signals; DO NOT recreate Cred's routing/auth/memory as nodes.
- Genuine data gap: per-category monthly spend (Cred usr.user_spend) is NOT in Credix's bureau
  doc. First cut: capture conversationally via the recommend tool; persist later if needed.

## 2026-07-13: Cred incorporation, code-level dependency map (for the sequenced plan)

Read Credix tool conventions + Cred source to sequence the incorporation easy->hard. Plan:
`docs/superpowers/plans/2026-07-13-cred-incorporation-sequenced.md`.

Credix tool conventions the port MUST adopt (from tools/{signals,bureau,eligibility}.ts):
- `createTool` (@mastra/core/tools) + zod in/out; `execute: async (inputData) => {}`.
- Fail-soft: return `{ ok:false, message }` / `{ available:false }`, do NOT throw on expected miss.
- PII-safe spans via `tracer.startActiveSpan` (lib/otel), counts/outcomes only, never raw
  score/income/PAN/mobile.
- `user_id` is an inputSchema FIELD (signals.ts/bureau.ts take it as an arg from the prompt/init
  data). This is Credix's actual wiring; DO NOT port Cred's `requestContext.pid`/getPid pattern
  (tool-context.ts). Deviation from blueprint prose noted in the plan.
  **CORRECTED 2026-07-29 (ZT-730):** this call was reversed. Relying on the LLM to echo `user_id`
  back from the prompt is the weak link (a paraphrased or dropped value reads the wrong user), so
  `getSignals`/`getStatement`/`getBureauDetail` now resolve it CONTEXT-FIRST from
  `context.requestContext.get('user_id')` with the arg only as fallback; server.ts builds one
  `RequestContext` per `/v1/chat` (user_id, channel, `MASTRA_RESOURCE_ID_KEY`) and masterStep
  forwards it to `masterAgent.generate` so delegated workers inherit it. The arg stays in the
  inputSchema for direct tool calls outside a run. Cred's shape was right; only its `pid` naming
  and `tool-context.ts` indirection were not ported.
- Drop on port: makeProgress/writer.custom (playground), card-web-fallback (use exaSearch),
  tool-context.ts. toModelOutput optional.
- Tests: src/mastra/__tests__/*.test.ts, bun test; mock memoised singletons via a SHARED factory
  (agent-mock.ts / exa-mock.ts); inline per-file stubs leak across files (see lessons.md).

Cred data layer (decisive for dependency tiers):
- Direct Postgres (Supabase) via lib/db.ts `Pool`; reward math lives ENTIRELY in SQL functions
  `catalog.rank_cards_for_spend(income, spend_jsonb)` + `usr.eligible_cards(pid)`
  (filtering/schema/eligible_cards.sql, ~29KB, migrations-deep, fallback chains/caps/milestones).
  => recommend/funnel genuinely need a LIVE Postgres; the ranking CANNOT be a JSON snapshot or a TS
  reimplementation (plan forbids reimplementing it).
- Catalog schema in filtering/schema/catalog.sql (~20KB); seed data in filtering/sources/{amex,axis,
  hdfc_bank,icici,kotak,sbi}. So a Credix-owned seeded DB is feasible.
- get-card-criteria.ts queries catalog.card directly; card reads (details/fees/benefits/criteria/
  earn-rate/partner-rates/compare/route-spend) all need catalog DATA but not the ranking function.

Dependency tiers (the crux of the sequencing):
- TIER 0 (no catalog, no decision) = WAVE 1: creditCardAgent instruction addendum using only
  existing tools + the own-report (bureau-report-summary) behaviour. One commit, ships now.
- TIER 1 (needs catalog reads) = catalog data layer + 8 read/math tools.
- TIER 2 (needs live ranking SQL + spend) = recommend/funnel/spend + 2 bureau-eligibility rewires.
- Already attached to creditCardAgent (do NOT redo): exaSearch, checkCardEligibility, getSignals,
  getStatement, getBureauDetail (credit-card.ts:19).

Wave 2 GATE (3 decisions block all catalog work): (1) hosting: Credix-owned DB [rec] vs Cred
Supabase vs static JSON (JSON can't run the ranking); (2) access: endpoints+lib/catalog-fetch.ts
[rec, mirrors bureau-fetch] vs direct pg Pool; (3) spend: conversational [rec] vs persisted.
UI tools (show-*/ui-cards/recommended-card-ui) already decided = deferred, never a node.

## 2026-08-04 — Prompt study: ../right-card agents vs credix agents (for PR #20)

Source: /home/beast/Documents/stag/right-card (sibling repo, same Mastra stack, xAI Grok, 5 agents,
25 commits of prompt fixes traced to tester logs) + part4_agents_and_engine.md + hallucination_audit.md.

### The architectural difference that decides what transfers

right-card ROUTES: intentAgent (JSON classifier, no tools, no memory) -> code picks ONE specialist
(research / eligibility / calculator / generalCredit) -> that specialist answers the user directly.
One LLM pass over the content. No synthesis step, so no synthesis bugs.

credix DELEGATES: master supervisor holds workers as delegation tools, calls one or more, then
SYNTHESIZES one reply. Two LLM passes over the same content.

Consequences, both directions:
- right-card cannot teach us synthesis rules, because it never needed any. The concatenation defect
  observed in our 2026-08-03 traces is ours alone to write rules for.
- The second pass is also why credix pays 16k-34k master prompt tokens ON TOP of 11k-38k worker
  tokens. right-card pays one of those, not both.
- Keep delegation anyway: cross-domain merges ("which card suits my score") need it, and a classifier
  cannot do them. This is a real capability, not accidental complexity.

### Prompt sizes
  right-card: research 712 lines, eligibility 105, calculator 104, intent 57, generalCredit 48
  credix:  credit-card 90, credix 60, master 52, persona 27
Not an argument for growth. right-card's bulk is catalog vocabulary (74 micro-categories) and a 6-step
UI intake flow that credix has no equivalent of.

### What right-card does that credix does NOT, ranked by evidence strength

1. FRONT-LOADED CRITICAL BLOCK (commit bd977f8, "front-load critical rules for attention, not just
   completeness"). ~8 never-violate lines at the very top, then "full detail lives further below".
   credix's persona.ts lists rules flat, with digits and no-dashes mid-list.

2. "Never announce a tool call ('let me check...') — call it silently, reply with the result."
   Verbatim in their CRITICAL block. credix has NO such rule anywhere, and this is exactly our
   observed defect (2 of 3 turns opened with "I'll pull...", "I'll get a clear side-by-side...").

3. INTERNAL VOCABULARY BAN LIST. They name the forbidden words: "income floor", "score floor",
   "bucket", "tier reference", "hard constraint", "NTC", "catalog", "database", "net value", tool names.
   EVIDENCE THIS BITES US: our own probe reply said "You sit in the prime segment with a thick file".
   `segment` and `file_tier` are internal signal taxonomy leaking to a user verbatim.

4. "Never reveal internal computation mechanics" (cea026e), phrased to survive rephrasing attacks
   ("how do you calculate this", "what's your formula", "why did this rank higher"). credix exposes
   signals/compose RANKING and has no rule about it.

5. IN-GENERATION CHECK: "About to write a rate, fee, or figure and you have not called a tool yet THIS
   turn — stop, call the tool, then write. Prior context is not a substitute for a fresh tool call."
   credix says "never answer a card fact from memory" but has neither the stop-and-check
   formulation nor the prior-turn clause. hallucination_audit H1 is precisely this gap.

6. PER-CARD DATA IN COMPARISONS: "Called a tool for ONE card does not license numbers for the OTHER."
   credix has compareCards but no such rule.

7. SELF-CONTRADICTION RULE: "If two of your own numbers disagree, re-derive from the tool result
   instead of publishing both." credix has nothing.

8. REPEAT GUARDS, both live-caught by their testers: "never resend a previous turn's reply verbatim"
   and "don't re-serve the identical answer to a DIFFERENT question" (same card recited 3x for a
   changed ask). credix guards repeated TOOL calls within a turn, not repeated REPLIES across turns.
   With OM memory and multi-turn sessions this is a live risk for us.

9. LANGUAGE HANDLING (lib/language-notes.ts, their finding 3d). Language detected upstream, put on
   requestContext, and appended to EVERY agent's instructions via dynamic `instructions:
   ({ requestContext }) => withLanguageNote(...)`. Covers hi / hinglish / ta / te.
   credix has NOTHING. For Indian users on WhatsApp and voice, Hinglish is the default register, so
   this is a product gap rather than prompt polish. credix already has the mechanism: RequestContext
   is threaded per request and Mastra supports function-valued instructions.

10. ASK-ONCE DISCIPLINE: "Ask each question exactly ONCE per message, never reworded", plus "never
    narrate self-corrections". Their eligibility agent records a live case where the same question
    appeared 3 times in one exchange. credix has "one question per turn at most" in credit-card.ts
    only, not in the persona or the credix worker.

11. "Never end a turn with only a tool call and no visible text" — because WhatsApp renders only text.
    credix has whatsapp and tts channels and already tracks `app.response.empty`, so the same hole
    exists; the workflow's fallback text masks it rather than preventing it.

12. EXEMPLARS. An <examples> block with 3 conversation-level correct-behavior cases (commit 902715f
    added these after persona batteries found the same ask written twice in 5 separate conversations).
    credix prompts contain ZERO examples.

13. NEXT-STEP QUESTION TABLE: a lookup of "just answered X -> good next question", 9 rows. credix
    says "end on the next step or the one question" without shape or examples. Partially working
    already: all our probe replies did end with a question.

### What credix has that right-card does not (do not regress)
  - 120-word cap and digits-only, both driven by the TTS channel; right-card has no voice constraint.
  - Masked-profile-first sourcing, tools only for genuine gaps.
  - Bad-data guards: income under ₹15,000/month, utilization outside 0-100%, FOIR exactly 0.0 with
    visible EMIs. right-card has an income-period trap rule instead (1 lakh = month or year, 12x error)
    which credix should borrow only if users ever state income directly.
  - The small-talk bridge (engage warmly, then bridge to money) — right-card hard-declines off-topic.
  - Delegation and synthesis.

### Verdict for PR #20
  Tier 1, fixes defects already seen in our traces: front-loaded CRITICAL block; no tool-call
  announcements; master synthesis rules (rewrite, never concatenate; no plan narration; one reply);
  internal-vocabulary ban list.
  Tier 2, grounding from the hallucination audit: in-generation check; per-card comparison data;
  self-contradiction re-derive; cross-turn repeat guard.
  Tier 3, product gap with the mechanism already in place: Hinglish and language notes via
  requestContext, applied to master and both workers.
  Tier 4, only if Tier 1-3 measurement shows a need: 2-3 exemplars, next-step question table.

## 2026-08-04 — xAI prompt caching, measured, and two corrections to my own advice

Method: repeated /v1/chat/completions calls to grok-4.20-0309-non-reasoning with an identical ~2830
token system message, varying only the tool count, reading prompt_tokens_details.cached_tokens.

  step                   tools  prompt  cached
  1. warm up                12    3641    2816  (77%)
  2. repeat                 12    3641    3584  (98%)
  3. CHANGED to 3 tools      3    3056    2816  (92%)
  4. repeat                  3    3056    3008  (98%)
  5. back to 12 tools       12    3641    3584  (98%)

FACT 1: caching is real and aggressive. An identical prefix comes back 98% cached.
FACT 2: changing the TOOL SET does not invalidate the cached system prefix. Step 3 kept the whole
        system block cached and only the changed tool segment (~240 tokens) went cold. Step 5 shows two
        tool-set variants staying cached at the same time.
FACT 3: 9 tool schemas cost ~585 tokens total (3641 - 3056), so roughly 65 tokens per tool.

CORRECTION A (mine, same session): I warned that per-request instruction/tool variation "breaks prompt
caching". It does not, per FACT 2. The "static text first, variable text last" rule is still good
hygiene, and our language note is correctly appended last, but it is not the load-bearing constraint I
described.

CORRECTION B (mine, same session): I called intent-based tool subsetting "the token lever". Wrong. On a
warm cache those 585 tokens are already billed at the cached rate ($0.20/1M vs $1.25/1M), so subsetting
saves about $0.0001 per turn. If we do it, justify it on DECISION QUALITY (12 tool choices vs 3 is fewer
chances to pick wrong, which is closer to right-card's own motivation in 25d06bd) and on cold-start
turns, never on tokens.

WHAT ACTUALLY MATTERS, and it reframes the whole prompt-structure discussion: a real master turn is
~34,000 prompt tokens (measured 2026-08-03). System plus tools is only ~3-4k of that, so ~10% is even
cacheable. The rest is masked profile, conversation history, OM observations and tool results, all
per-turn and inherently uncacheable. Every prompt-structure micro-optimisation is rounding error against
improvements.txt item 2. The cheap next step there is unchanged and still undone: log prompt char counts
per contributor in masterStep, one line per turn, and find out which of the six is 30k tokens.

Also worth knowing for the PII audit: Mastra's TracingOptions has `requestContextKeys`, which extracts
RequestContext keys into trace metadata. credix does not set it. If anyone does, note that `user_id`
in requestContext is a RAW MOBILE, so it would reach Langfuse through a door the 1c806be audit did not
cover.
