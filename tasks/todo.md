# TODO

## Goal
Build the bureau pre-processing pipeline in `pre-processing/`: a read-through
resolver (Redis L1 → MongoDB L2 → Snowflake L3) that, given a mobile number,
serves a categorized bureau JSON and on a miss fetches from Snowflake,
normalizes the flat row, and enriches both Mongo (`captain_ai.bureau_data`,
full doc incl. PII, immutable per scrub-month) and Redis (`cc:profile:{token}`,
PII stripped, TTL'd). Wire a global `staging/.env` and stand up RedisJSON in Docker.

Full plan: `pre-processing/PLAN.md`.

## Phases

- [x] **Phase 1 — Global env** `complete`
  Global `staging/.env` (MONGODB_URI/DB, REDIS_URL/TTL), `staging/.gitignore`,
  `pipeline/env.py` (local-then-global loader).
- [x] **Phase 2 — Infra/deps** `complete`
  `docker-compose.yml` (redis/redis-stack-server), `requirements.txt` (pyyaml, redis).
- [x] **Phase 3 — Normalizer** `complete`
  `identity.py` (reuse `mobile_to_token`), `config/scrub_mapping.yaml`, `normalizer.py`.
- [x] **Phase 4 — Repositories** `complete`
  `repositories.py`: MongoRepo (`bureau_data`, `_id={token}:{scrub_month}`) + RedisRepo (RedisJSON, PII-stripped, ReJSON guard).
- [x] **Phase 5 — Snowflake source** `complete`
  `snowflake_source.fetch_scrub_row` reusing `fetch_bureau_profile` by file import.
- [x] **Phase 6 — Resolver + CLI + docs** `complete`
  `resolver.py` (L1→L2→L3 + lock + schema_version gate), `resolve.py`, README, PLAN.
- [x] **Phase 7 — Verify end-to-end** `complete`
  Token parity test + cold/L1/L2/slice all green; ruff clean.

- [x] **Phase 13: Cred integration (planning only)** `complete` (2026-07-10, plan drafted; build not started)
  Wrote `docs/superpowers/plans/2026-07-10-cred-into-credix.md`: fold Cred's credit-card depth
  into Credix WITHOUT adding workflow nodes. Governing principle: keep Credix's orchestration
  (understand/branch/agent/compose), import only Cred's domain depth as tools on the existing
  `creditCardAgent`, plus a card-catalog data layer behind those tools (same pattern as the bureau
  sidecar). Explicitly NOT imported: Cred's proxy, intent detector/intentAgent, resolveSkill,
  profile-sync, auth/OTP, libSQL memory, and the 4 extra agents (they collapse into the one
  credit-card agent; generalCredit maps to existing general/score agents). Build phases 0-5 defined
  in the plan; UI cards + persisted spend deferred as a separate out-of-pipeline track. Findings in
  tasks/findings.md (2026-07-10 Cred section).

- [ ] **Phase 14: Cred incorporation, sequenced by dependency** `in_progress` (2026-07-13)
  Issue: `issues/006-cred-catalog-tools-integration.md` (full scope, checks, 3 testing sections,
  as-built status). Tracking: Jira ZT-597, GitHub financebuddha/credix#13
  (https://github.com/financebuddha/credix/issues/13). Sequenced execution plan:
  `docs/superpowers/plans/2026-07-13-cred-incorporation-sequenced.md`. Findings: tasks/findings.md
  (2026-07-13). PROGRESS: catalog data layer (direct pg reuse of Cred Supabase) + 6 read tools DONE +
  live-verified (tsc 0 · bun test 232 pass · live e2e 8/8). Pending: math (earn-rate, route-spend),
  Tier-2 (recommend/funnel + spend), 3 bureau rewires, instruction addendum, data-layer decision.
  Ordering is strictly by dependency tier:
  - **Wave 1 (Tier 0, zero catalog dep, ship now):** ONE commit. New `agents/credit-card-instructions.ts`
    `CREDIT_CARD_ADDENDUM` composed into creditCardAgent instructions (card facts must be sourced via
    exaSearch not memory; approval-odds framing via checkCardEligibility+getSignals; own-report
    behaviour from bureau+signals, PII-safe). Tool set UNCHANGED. Test in `__tests__/agents.test.ts`.
    Scope `agents`. This is the "easy one with less dependency"; needs no catalog and no decision.
  - **Wave 2 (Tiers 1+2, catalog-backed):** GATED on 3 decisions (hosting / access shape / spend
    capture; see plan "Wave 2 Gate" + findings). To be broken into bite-sized steps AFTER the gate.
    Phase sketch: 2A catalog data layer (root dep) -> 2B read tools -> 2C math/compare -> 2D
    recommend+funnel+spend+bureau-eligibility rewire -> 2E instructions(catalog-first)+verify.
  Handoff note: Wave 1 has no dependency on Wave 2 and can land in parallel with Wave 2 planning.
  Next action: execute Wave 1 (one commit), and settle the 3 Wave-2 gate decisions to plan Wave 2.

  **UPDATE 2026-07-13: user chose to skip Wave 1 and go straight to tool integration, easiest first.**
  Gate decisions taken (low-friction path, reversible): (1) hosting = REUSE Cred's Supabase directly;
  (2) access = direct `pg` Pool in a shared lib (NOT endpoints+client yet); (3) spend = deferred
  (not reached). Progress:
  - [x] Foundation: `bun add pg @types/pg`; `lib/catalog-db.ts` (lazy `getCatalogPool()` +
    `resetCatalogPoolForTests()`, CATALOG_DB_UNAVAILABLE, ported SSL opt-ins DB_SSL_CA/DB_SSL_VERIFY).
    `.env.example` documents DATABASE_URL. Env to add to repo-root .env: **DATABASE_URL** (copy from
    Cred/.env), optional DB_SSL_CA / DB_SSL_VERIFY.
  - [x] `getCardCriteria` (tools/card-catalog.ts) ported from Cred get-card-criteria.ts, attached to
    creditCardAgent, 6 unit tests (mocked pg). Dropped on port: makeProgress, card-web-fallback,
    toModelOutput. tsc 0 · bun test 216 pass/14 skip/0 fail. NOT committed.
  - [x] Matcher: `lib/catalog-cards.ts` ported (cardMatchSql/resolveCardCandidates/editionAmbiguity/
    issuerMatches + ranking helpers for later). db accessor -> getCatalogPool.
  - [x] `getCardFees`, `getCardPartnerRates`, `getCardBenefits` ported + attached + tested + LIVE
    smoke green (tsc 0 · bun test 226 pass). NOT committed. See progress.md 2026-07-13 batch 2.
  - [x] `getCardDetails` (aggregator, 7 tables) + `compareCards` ported + attached + tested + LIVE
    smoke green (tsc 0 · bun test 232 pass). NOT committed. See progress.md 2026-07-13 batch 3.
    READ TIER COMPLETE (6/10: criteria, fees, partner-rates, benefits, details, compare).
  - [ ] Then math: getCardEarnRate (43KB), routeSpend.
  - [ ] Then Tier 2 (ranking SQL + spend): recommendCard, explainEligibilityFunnel, bureau-eligibility
    rewires.
  - [ ] **Quality follow-up (before user-facing):** move the dropped toModelOutput narration-correctness
    rules into creditCardAgent instructions (year-one fee = joining only; insurance covers never summed;
    "up to" maximums; instant-discount != points; edition-ambiguity disclosure; catalog-first then
    exaSearch). This is the deferred Wave-1 addendum, now REQUIRED once tools are in.

  **UPDATE 2026-07-15: read tier COMMITTED + Copilot-hardened; the "NOT committed" notes above are stale.**
  The 6 read tools + catalog data layer are committed (f05bbee, 2863656, 51b3385) on PR #15
  (financebuddha/credix#15). Two Copilot re-review waves resolved to 0 unresolved: wave 1 = 56d9020
  (lounge `network` nullable in row type + output schema; getCardPartnerRates derives `mode` from request
  shape; compareCards picks the MIN lounge spend gate; StubPool.query params optional); wave 2 = 64f743c
  (keep tier=NULL base-lounge rows in all 3 "base tier only" queries) + e5ae41a (document DB_SSL_* vars).
  Full bun test 236 pass, tsc 0. Still pending (unchanged): math tier (getCardEarnRate, routeSpend),
  Tier-2 (recommend/funnel/spend + 3 bureau rewires), the credit-card instruction addendum.
  Separately, PR #14 (feat/bureau-python-wrapper) was linearized onto dev this session (rebase -X theirs,
  final tree byte-identical to 9216d11, force-pushed 47d9fac); the cred branch is stacked on it.

  **UPDATE 2026-07-16: getCardFullProfile tool + creditCardAgent instruction addendum shipped on a
  stacked PR #16** (branch feat/full-card-profile-agents, base feat/cred-catalog-tools). New tool
  merges getCardDetails+getCardBenefits+getCardPartnerRates into one call (granular tools kept);
  CREDIT_CARD_ADDENDUM wires catalog-first discipline into creditCardAgent. This DELIVERS the
  "instruction addendum" that was still pending above (creditCardAgent only; score/insurance/credix
  left as-is by scope choice). Still pending: math tier + Tier-2 + the 3 bureau rewires. Full bun test
  260 pass, tsc 0. Spec: docs/superpowers/specs/2026-07-16-card-full-profile-tool-design.md.

- [x] **Restructure — canonical `src/credit_credix/` LangGraph layout** `complete` (2026-06-19)
  Materialized the full `docs/architecture/repo-structure.txt` tree; migrated the
  Phase-1 bureau pipeline into `raw_data/bureau/` (git mv, imports rewritten, repos
  split, snowflake merged); added `pyproject.toml`/`langgraph.json`/`Makefile`/
  `config/settings.py`; deleted legacy folders. pytest 4/4 + ruff green. Branch
  `restructure/langgraph-layout`, not committed. See `progress.md` (2026-06-19).
  Follow-ups: token→sha256; extract `partial_reads.py`; build Phase-2/3; integrate
  `rahul-front`; `langgraph dev` needs `pip install -e ".[graph]"`.

- [x] **Issue 001 — Hono + Mastra bootstrap + Python data sidecar** `complete` (2026-06-23)
  TypeScript scaffold under `src/mastra/`: package.json, tsconfig (bundler resolution),
  lib/provider.ts, lib/patterns.ts, index.ts (libsqlStore + mastra exports), server.ts
  (Hono on PORT; startup guards for INTERNAL_API_SECRET and port-2024 collision).
  FastAPI demoted to data sidecar: bureau_internal.py with hardened route handlers.
  chat.py deleted atomically with app.py change. `pnpm typecheck` exit 0, ruff clean.

- [x] **Issue 002 — Deterministic steps + tools** `complete` (2026-06-24)
  Implemented and tested: decodeStep (NFC + lang detect + ElevenLabs STT), preGuardrailStep
  (injection/scope filter + bureau fetch + partial PII masking), postGuardrailStep (full PII
  redaction, lastIndex-safe), composeStep (WhatsApp/web/TTS with ElevenLabs eleven_flash_v2_5),
  calculateEmi + calculateFoir tools. 92 tests pass (steps + tools + patterns). eligibility.ts
  stub kept as SKIP for Issue 003. See `tasks/plan/plan-issue-002.md`.

- [x] **Issue 002 — TTS/STT hardening + retry** `complete` (2026-06-25)
  `lib/retry.ts`: withRetry<T> — 3 attempts, 500ms/1000ms exponential backoff, fast-fail on 4xx
  (except 429). `decode.ts`: STT wrapped in withRetry; Bun-safe Buffer+WithMetadata upload for
  local files (fixes createReadStream crash). `compose.ts`: TTS wrapped in withRetry; empty
  stream guard (treats 0-byte response as 500). `pre-guardrail.ts`: renamed guardrail_ok →
  pre_guardrail. steps.test.ts: mockState stateful, afterAll cleanup prevents bleed into
  integration.test.ts, 6 new retry tests added (503 recovery, 402 fast-fail, exhaustion).
  integration.test.ts: ElevenLabs guard requires real sk_ key; bureau guard requires BUREAU_LIVE=true.
  .env: API key and voice ID split onto separate lines (same-line bug corrupted key in Bun).
  Final test result: 98 pass · 9 skip · 0 fail.

- [x] **Issue 002 — Documentation & PR preparation** `complete` (2026-06-25)
  `tasks/issues-2.md`: official PR document with Gantt, STT/TTS retry sequence diagram, pre-guardrail
  data layer sequence diagram, 7 bugs fixed table, live probe results.
  `README.md`: full rewrite — system architecture flowchart, bureau L1/L2/L3 flowchart, pipeline
  sequence diagram, implementation Gantt, config table, conventions, roadmap. All Mermaid diagrams
  GitHub-compatible (no \\n in participant names or Note blocks).
  PR description drafted: ZT-481 Subtask(ZT-435), closes GitHub #3 and #6 on merge.

- [x] **Issue 003 — Bureau tools, identity check, LLM understand step** `complete` (2026-06-25)
  `tools/bureau.ts`: getBureauProfile + getBureauDetail — pii key stripped before returning to agents.
  `steps/identity-check.ts`: normalizeUserId() exported for server.ts API boundary, step never throws
  on sidecar errors (returns identity_verified: false + error code). `steps/understand.ts`: short-circuits
  on pre_guardrail: false (zero LLM spend on blocked messages); Grok classifies intent into 5 canonical
  values via direct xAI API call with response_format json_object. `steps/memory-writeback.ts`: no-op
  skeleton wired for Issue 004. Tests: bureau-tools, identity-check, understand — all mocked, 23 new tests.
  Final test result: 121 pass · 9 skip · 0 fail. PR #7 open (closes #3 + #6 on merge).

- [x] **Issue 004.1 — Building blocks + understanding redesign** `complete` (2026-06-26) [ZT-496, GH #8]
  Standalone pieces for the 004.2 workflow (NO assembly, NO index registration — those are 004.2).
  `agents/persona.ts`: RAHUL_PERSONA. `agents/{score-improvement,credit-card,insurance,credix}.ts`:
  real `new Agent()` on `grokModel` + `credixMemory` + tools (closes Sudhanshu review #4 — provider
  exports no longer dead). `agents/index.ts` barrel. `tools/eligibility.ts`: `checkCardEligibility`
  pure decision tree (premium/standard/secured). `memory/index.ts`: `credixMemory` singleton —
  `Memory` over the shared `libsqlStore`, schema-mode working memory (`goals`/`hard_constraints`/
  `prose_summary`), `scope:'resource'`. `steps/understand.ts`: redesigned — lazy `understandAgent`
  (grok-4.3, env-tunable `UNDERSTAND_MODEL`/`UNDERSTAND_REASONING`) + Mastra structured output emits
  `{ intent, brief{summary,points} }`; preserved short-circuit, fail-fast-on-missing-key, and
  `llm_<status>`/`llm_unreachable` degradation. `provider.ts`: added `understandModel`.
  Tests: eligibility (new), understand (rewritten to mock `@mastra/core/agent`), agents smoke (new).
  Verified: `bunx tsc --noEmit` exit 0 · `bun test` 149 pass · 9 skip · 0 fail. Not committed yet.
  Forward-flags for 004.2 recorded in `lessons.md` (updateWorkingMemory signature, `.payload` tool
  trace shape, import-cycle ordering).

- [x] **Issue 004.2 — Workflow assembly + single-fetch bureau** `complete` (2026-06-28) [GH #9]
  `workflows/credix-workflow.ts`: assembled decode→pre-guardrail→understand→`.branch()`→`.map()`
  →post-guardrail→memory(no-op)→`.map()`→compose. `makeAgentStep` (maxSteps 3, memory resource/thread,
  `tool_calls_log` from `result.steps[].*.payload.*`, empty-string guard) + `guardrailRejectStep`
  (shared schema, no LLM). Two `.map()` seams: collapse-branch→agentOutputSchema, and buildComposeInput
  (recovers response + channel/session_id via getInitData + active_skill). `lib/bureau-fetch.ts` shared
  `fetchBureau` (closes review #3). `pre-guardrail.ts`: stopped fetching — masks `getInitData().bureau_profile`.
  `memory-writeback.ts`: no-op pass-through (memory deferred). `lib/storage.ts`: extracted `libsqlStore`
  to break the index→agents→memory→index cycle (ESM hoisting makes "ordering" impossible). `index.ts`:
  registered 4 agents + workflow. `understand.ts`: exported `understandOutputSchema` (shared branch input).
  Tests: `__tests__/agent-mock.ts` shared harness (spreads real module, overrides Agent, drives generate
  via mutable state); `workflow.test.ts` (routing/reject/seams, dynamic-import after mock.module);
  rewrote agents/understand tests onto the harness; updated steps.test pre-guardrail to single-fetch.
  Verified: `bunx tsc --noEmit` exit 0 · `bun test` 155 pass · 9 skip · 0 fail. Not committed yet.
  Deferred to 004.3: server `/v1/chat` wiring, E2E, Sudhanshu #4/#5/#6, live grok-4.3 probe.

- [x] **Issue 004.3 — Server wiring + E2E + cleanups** `complete` (2026-06-28) [GH #10] — **Issue 004 DONE**
  `server.ts`: exported `app`; moved env guards + `serve()` + signal handlers behind an `isEntry`
  guard (`process.argv[1] === fileURLToPath(import.meta.url)`) so tests import `app` without binding a
  port. `POST /v1/chat` now: `fetchBureau(user_id)` → notFound 200 / transport 502; then
  `mastra.getWorkflow('credixWorkflow').createRun().start({inputData})` (registration KEY, not the
  workflow id); non-success → 502; success → `{response: result.result.composed, session_id,
  active_skill}`. `__tests__/e2e.test.ts`: 8 scenarios over the real app via `app.request` (agents
  stubbed by the shared harness which now EXTENDS the real Agent so Mastra registration's
  `__setLogger` etc. work; node:http mock sidecar) — intent routing, injection→guardrail-reject (0 LLM
  calls), not_found, no PAN, session echo, 400 invalid mobile. Cleanups: #6 hoisted
  `new ElevenLabsClient` out of the withRetry closure in decode/compose; #5 documented stripPii's
  object-only contract + getBureauDetail handles bare-array sections (strips pii on objects, wraps
  arrays); #4 `.env.example` LLM comment + `UNDERSTAND_MODEL`/`UNDERSTAND_REASONING`. `.gitignore`:
  added `mastra.db*`. Verified: `tsc` exit 0 · `bun test` **163 pass · 9 skip · 0 fail**. Not committed.
  Still unverified: live grok-4.3 structured-output (all tests mock the agent) — manual probe pending.

- [x] **Phase 11 — Live multi-node workflow E2E (real Grok + real bureau)** `complete` (2026-06-29)
  Ran `credixWorkflow` end-to-end with REAL data through every node: real Hono `app` ->
  fetchBureau -> live Python sidecar (Redis L1 + Mongo L2 + Snowflake L3) -> understand (live Grok)
  -> specialist (live Grok + tools) -> post-guardrail -> compose. Nothing mocked.
  Test: `src/mastra/__tests__/e2e.live.test.ts`, gated on `LIVE_E2E=true` + `E2E_LIVE_MOBILE` (no
  numbers committed). Covers injection-reject (deterministic, no LLM) and PII-safety (full real pass).
  Result: 2 pass, 13 assertions. A real credit question routed to `score_improvement` and returned a
  coherent reply built from the real profile (score 900, 0% utilization), digits-not-words, no PII.

  Bugs the live run surfaced and fixed:
  1. `GROK_API_KEY` was a Google Gemini key (`AIza...`), not xAI. User swapped in a valid `xai-` key.
  2. `provider.ts` used the OpenAI Responses API by default (`grokProvider(id)` -> /v1/responses),
     which xAI rejects with 422 "did not match enum ModelInput". Fixed to `grokProvider.chat(id)`
     (Chat Completions) for both `grokModel` and `understandModel`.
  3. `grok-4.3` confirmed valid (it is `grok-latest`, the reasoning model); no model-id change needed.
  Minor finding (not fixed): INJECTION_PATTERNS catches "ignore previous instructions" but not
  "ignore ALL previous instructions" (the `all` breaks `/ignore\s+(previous|prior)/`).
  Verified: `tsc` exit 0; gated test skips by default (3 skip). Not committed yet.

- [x] **Phase 9 — Raw Data Layer: bureau Python wrapper + snowflake_client.py cleanup** `complete` (2026-06-29) [issues/005]
  9a: `client.py` single-import facade (`get_bureau_profile`/`get_bureau_section` async via
  `asyncio.to_thread`, plus `_sync` twins); `errors.py` typed hierarchy (`BureauError`,
  `InvalidMobile`, `BureauUnavailable(layer)`); `partial_reads.py` `VALID_SECTIONS` + `select_section`.
  Resolver gained `force_refresh`. Deviation from the original note: no-record returns None, infra
  failure RAISES `BureauUnavailable` (a Redis outage must not look like a brand new user).
  9b: `snowflake_client.py` made import-side-effect-free (lazy `load_dotenv`/default connection inside
  `connect()`, `print`→`logging.debug`); CLI moved to `scripts/fetch_bureau_profile.py`.
  Route `bureau_internal.py` now imports `VALID_SECTIONS` from the shared module.
  Verified: ruff clean · `pytest tests/` 13 pass (9 new client cases). Not committed yet.

  Original plan (kept for reference):
  Goal: make bureau data for any user trivially accessible from Python in one call. Currently the
  resolver chain (Redis L1 → Mongo L2 → Snowflake L3) works but requires wiring through factory.py
  each time. Two parallel workstreams:

  **9a — Clean Python bureau client interface (new)**
  Create `src/nodes/raw_data/bureau/client.py` — a single-import facade over the full resolver:
  ```python
  from nodes.raw_data.bureau.client import get_bureau_profile
  profile = await get_bureau_profile('9876543210')   # returns PII-stripped dict or None
  ```
  - `get_bureau_profile(mobile: str) → dict | None`: normalises mobile → user_id, calls resolver,
    strips pii key, returns categorized bureau JSON. Returns None on no-record (404) or sidecar down.
  - `get_bureau_section(mobile: str, section: str) → dict | None`: single-section shortcut.
  - Both functions handle the full L1→L2→L3 path transparently — callers never touch resolver/factory.
  - Async-native (motor/asyncio), re-uses the existing singleton from factory.py (no new connections).
  - Add `tests/unit/test_bureau_client.py` — mock resolver, test PII stripped, test None on error.

  **9b — snowflake_client.py library cleanup (existing)**
  `src/nodes/raw_data/bureau/snowflake_client.py` is half CLI script, half library. Four fixes:
  1. `load_dotenv()` at module import time (line 60): move inside `connect()` or remove (FastAPI
     startup already loads env via python-dotenv).
  2. `print()` to stderr in `connect()`: replace with `logging.debug()` — one raw print per
     Snowflake connection currently leaks to production logs.
  3. CLI dead code (`parse_args()`, `run()`, `main()`, `if __name__ == "__main__"`): move to
     `scripts/fetch_bureau_profile.py` so the library module is importable without side effects.
  4. `DEFAULT_CONNECTION = os.getenv(...)` at module level: read inside `connect()` instead —
     value is currently locked at import time, ignores runtime env changes.
  What IS correctly wired: `fetch_scrub_row()` extracted and used by resolver via factory.py.

- [ ] **Phase 10 — TypeScript graceful error-handling** `not_started`
  Apply structured, consistent error-handling across all Mastra steps, tools, and the Hono server.
  Currently each step handles errors differently (some throw, some return error strings, some swallow).

  **Skill to install first:**
  ```
  npx skills add https://github.com/pluginagentmarketplace/custom-plugin-nodejs --skill error-handling
  ```
  Run this before starting — the skill provides the error-handling patterns and conventions to follow.

  **Scope:**
  - `server.ts`: Hono global error handler — catch unhandled step errors, return `{ error, code }` JSON
    with appropriate HTTP status (400 user error, 500 internal, 503 sidecar down).
  - `steps/decode.ts`: STT error → structured `{ error: 'stt_failed', detail }` not raw throw.
  - `steps/pre-guardrail.ts`: bureau fetch already silently swallows — make it log with `console.warn`
    so failures are visible without breaking the request.
  - `steps/understand.ts`: LLM API non-ok currently throws — wrap in structured error with retry hint.
  - `tools/bureau.ts`: sidecar errors throw raw — wrap as `BureauSidecarError` with `status` field
    so callers can distinguish 404 (no record) from 500 (infra down).
  - Add `lib/errors.ts`: typed error classes (`BureauSidecarError`, `LLMApiError`, `STTError`,
    `TTSError`) with `toHttpResponse()` helper for Hono handlers.
  - All step errors should be catchable without crashing the workflow — workflow continues with
    a degraded response rather than a 500 to the user where possible.

  **Test coverage:** add error-path tests for each step/tool using the patterns from the skill.

- [ ] **Phase 8 — Canonical key = 10-digit mobile + 15-day window** `in_progress`
  Replaced sha256 `mobile_to_token` with `mobile_to_user_id` (bare 10-digit mobile)
  across JSON (`user_id`), Mongo (`_id={user_id}:{scrub_month}`) and Redis
  (`cc:profile:{user_id}`). Added app-level 15-day Mongo freshness window
  (`BUREAU_FRESH_DAYS`, fixed from `fetched_at`) so returning users skip Snowflake.
  `captain_ai`/`user_token` join dropped. New `tests/test_identity.py` (normalization
  + freshness). ruff + pytest green. **Remaining:** end-to-end smoke (cold/L1/L2/stale)
  against live Redis+Mongo+Snowflake, then commit.

- [x] **Phase 12 — Credix scope: welcome interests, bridge to finance** `complete` (2026-07-01)
  All 5 edits done; tsc clean; 108 tests pass (patterns/steps/understand/workflow). Not committed yet.
  Product call: scope guardrail floor = unsafe/abuse only (keep injection). Common-interest
  topics (sport/food/weather/astrology/markets) no longer hard-rejected; the shared persona
  bridges them to the user's money + daily-life preferences. See memory `project_scope_philosophy`.
  Steps:
  1. `lib/patterns.ts` — replace `SCOPE_PATTERNS` (topic denylist) with `UNSAFE_PATTERNS` (self-harm/violence/illegal/explicit); keep `INJECTION_PATTERNS`.
  2. `steps/pre-guardrail.ts` — import `UNSAFE_PATTERNS`; reject reason `out_of_scope` → `unsafe`.
  3. `workflows/credix-workflow.ts` — guardrailRejectStep: safe-refusal message for `unsafe`.
  4. `agents/persona.ts` — add bridging behavior to `RAHUL_PERSONA`.
  5. Tests: `patterns.test.ts` (interests now pass, unsafe blocked), `steps.test.ts` + `understand.test.ts` (`out_of_scope` -> `unsafe`).
  Verify: `npx tsc --noEmit` + bun tests green, then commit.

- [x] **Interface integration — wire interface/ (was rahul-front/) to Mastra `/v1/chat`** `complete` (2026-07-01)
  Renamed `rahul-front/` -> `interface/`, committed source (scaffolds/lockfile excluded).
  Replaced the LangGraph SDK runtime with a same-origin Next proxy (`app/api/chat/route.ts`) +
  `useCredixRuntime` adapter (single-shot, abort/timeout/graceful errors, session_id
  persistence). Phone-capture onboarding; first intro bubble from a real seed call. Removed all
  `@langchain/*` deps + dead backend graph. Design/plan in `docs/superpowers/`.
  Verify: tsc 0, `next build` 0, proxy 502-degrades with backend down. Commits 2be86ba,
  9daef40, 999bd8b, 949a62e. **Pending:** full live E2E with the real backend stack.

## Errors encountered

| Error | Cause | Fix |
|-------|-------|-----|
| `bson InvalidDocument: key was 3060` | YAML read DPD bucket keys `30_60`/`60_90` as ints (`_` digit separator) | Quoted the numeric keys in `scrub_mapping.yaml` |
| `address already in use :6379` | Pre-existing plain Redis on 6379 (no ReJSON) | User stopped it; redis-stack now on 6379 |
| `ModuleNotFoundError: pipeline` in tests | test run dir on path, not package root | `sys.path.insert` package root in the test |

## Out of scope (later)
- FastAPI service + Dockerfile wrapping the resolver.
- Local dockerized Mongo (using Atlas).

- [x] **Observability — wire Honeycomb to the live workflow (OTEL on every turn)** `complete` (2026-07-03)
  The whole workflow was already instrumented (server `credix.workflow` span → decode / pre-guardrail
  / understand.classify / agent.generate / post-guardrail / compose / memory-writeback + bureau.fetch),
  and `tracing.ts` exports OTLP → Honeycomb. The only gap: the running path (`make dev-mastra` → `bun run
  dev`) used the UNTRACED script, so the SDK never booted. Fix:
  - `src/mastra/package.json`: `dev` now boots the SDK (`--import ./tracing.ts`); old command kept as
    `dev:untraced`. Every entry point (`make dev`, README, interface docs all call `bun run dev`) is now
    traced with zero other edits.
  - `src/mastra/tracing.ts`: degrade gracefully — if neither OTEL endpoint nor headers are set, log a
    notice and skip `sdk.start()` (no localhost:4318 connection-refused spam on a fresh clone / CI).
    Wrapped the `sdk` + shutdown handlers in the `otlpConfigured` guard.
  - `.env` / `.env.example`: added `OTEL_BSP_SCHEDULE_DELAY=2000` so spans flush every 2s (snappy live view).
  Verified live: `bun run dev` boots the SDK ("exporting to https://api.honeycomb.io"); a real `/v1/chat`
  turn ran the full workflow (real Grok, active_skill=general); a direct OTLP probe to
  `api.honeycomb.io/v1/traces` with the configured ingest key returned **HTTP 200** (key valid, service
  `credix-mastra`). tsc 0 · bun test 184 pass / 14 skip / 0 fail.
  Deliberately NOT enabled: Mastra's native AI tracing (would capture raw prompts + bureau data →
  PII leak); the custom PII-safe spans stay the source of truth. Known minor caveat: server.ts's SIGTERM
  `process.exit(0)` can pre-empt tracing.ts's async shutdown flush, so the last <2s of spans may drop on
  a graceful stop — negligible for live viewing since the batch processor exports every 2s at runtime.

- [x] **Observational Memory — enable OM on the specialist agents** `complete` (2026-07-03)
  Enabled Mastra Observational Memory (OM) on the shared `credixMemory` so every specialist agent
  gets humanlike long-context memory. Decisions: (a) reuse the existing `grokModel` as the
  Observer/Reflector model (backed by `GROK_API_KEY`) instead of the default `google/gemini-2.5-flash`
  — the project has no Google/xAI-router key; OM's `model` accepts a LanguageModel instance.
  (b) `scope: 'thread'` (session_id) — Mastra's own guidance is thread scope for existing apps
  (resource scope is experimental, disables async buffering, slow with many threads). Cross-session
  durability is already covered by the resource-scoped working memory. Env-flippable via `OM_SCOPE`.
  (c) thresholds env-tunable (`OM_MESSAGE_TOKENS`/`OM_OBSERVATION_TOKENS`/`OM_ASYNC_BUFFER`).
  KEY FINDING: OM's automatic observe-on-turn trigger does NOT fire through the workflow's
  non-streaming `agent.generate` path (processInputStep runs but no observation results; `.stream`
  also failed to trigger). The OM engine itself works — `engine.observe()`/`finalize()` produce
  correct observations. So the (previously no-op) `memory-writeback` step now drives OM explicitly at
  end of turn via `getStatus()` -> `finalize()`/`reflect()` (fail-soft), which is the framework's own
  documented "end of turn sequence" pattern. Verify: `__tests__/om.live.test.ts` drives 4 real Grok
  turns through the whole workflow on one session, then asserts `credixMemory.getContext()` reports
  `hasObservations` and a stated fact survived. tsc 0; `bun test` 184 pass/14 skip/0 fail; live e2e
  1 pass (149s). Not committed yet.

- [x] **Resilience — graceful failure for the orchestration** `complete` (2026-07-02)
  Cover 3 workflow resilience gaps so a transient upstream failure degrades instead of 502-ing:
  (R1) specialist `agent.generate` retry (withRetry) + safe fallback message in `makeAgentStep`,
  add `agent_error` marker; (R2) fail-soft `compose` on TTS failure — return text + `tts_failed`
  instead of throwing; (R3) surface `tts_failed` in `/v1/chat`, E2E degraded-path tests, full
  verify; (R4 optional) harden the `firedBranch` seam. Reuses `lib/retry.ts` + `lib/errors.ts`.
  TDD per failure path via the shared `__tests__/agent-mock.ts` harness (dynamic import after
  mock.module; stub Agent extends real). Full plan: `tasks/plan/plan-resilience.md`.

- [x] **Bureau reuse — fetch once per user, reuse across turns (in-process cache)** `complete` (2026-07-07)
  `lib/bureau-fetch.ts`: module-level `profileCache` Map keyed by `user_id`, TTL `BUREAU_CACHE_TTL_MS`
  (900000ms default, 0 disables) + size cap `BUREAU_CACHE_MAX` (1000). Read on entry (hit -> skip HTTP,
  `app.bureau.cache=hit`), write after `ok` (`=miss`); only `ok` cached; not_found/error re-try;
  `clearBureauCache()` test hook. Transparent at the fetchBureau boundary (server.ts/workflow untouched).
  Per-PROCESS cache (V8 heap, ESM singleton) — the fleet-wide shared cache remains the sidecar Pogocache L1.
  `.env`/`.env.example` document the knob; `__tests__/bureau-fetch.test.ts` (4 cases). Verified tsc 0 /
  bun test 188 pass; live trace 209aa26b... shows miss(1) 57ms + hit(2) ~0ms. Committed 08e74d5.

- [x] **Observability probe harness (single + multi-turn) + READ_FLOW doc** `complete` (2026-07-07)
  `scripts/probe-turn.ts` + `bun run probe`: drives real `/v1/chat` turn(s) through the traced workflow and
  exports to Honeycomb. `probe.local.json` (gitignored) = `{ mobile, messages[], channel?, session_id? }`;
  multi-turn runs on ONE session_id under one `probe.session` trace. `src/mastra/READ_FLOW.md`: source-derived
  sequence diagram + span tree of a turn. Honeycomb MCP now authed (get_trace/get_span_details usable).

- [x] **Latency (RE-OPENED after real multi-turn trace) — understand.classify ~6s + specialist round-trips** `complete` (2026-07-08)
  SHIPPED as 4 commits (0bb407d intent-only classify, b15e24d parallel Exa grounding, 9ffea32 detach
  getBureauProfile, e0fb2cc undici keep-alive) and VERIFIED on live trace 115eb5c4d658ab83b85002fe564fe870:
  warm turns ~10s (was 15-18s), classify 2.9-3.5s (was 5.24s avg; residual is xAI-side TTFB),
  grounding fully hidden under classify, tool_calls.count 0 everywhere, connections reused turn 2+.
  Residual follow-ups split out below. Original plan text follows.
  Full approved plan: `tasks/plan/plan-latency-2.md`. Baseline = trace 209aa26b208d4898a043c34080035001
  (2026-07-07 12:16 UTC, 3 turns, 15-18s/turn: classify 4.7-6.9s + exa 0.6-0.8s serial + x.ai 9-10s).
  Phases (one commit each):
  A. intent-only classify (drop the brief; Mastra structuredOutput confirmed "direct" mode = 1 POST,
     cost is output tokens). Fallback if flat: restore 59153fe direct chat.completions or maxOutputTokens cap.
  B. parallelize Exa grounding with classify inside understandStep (own `web.grounding` span started
     BEFORE the classify span; web_context on all 3 return paths; bureau_query discard post-classify;
     `web_context` optional field through understandOutputSchema; delete EXA_API_KEY in test beforeAll).
  C. remove getBureauProfile from score-improvement/credit-card/credix agents (root cause of 17 xAI
     POSTs / 13 turns); keep getBureauDetail; tool export stays (dead-code candidate).
  D. undici ^6.23.0 keep-alive via lib/http-dispatcher.ts imported first in server.ts (not tracing.ts);
     drop phase if probe trace still shows tls.connect per turn.
  Verify per phase: tsc -> bun test -> bun run probe -> Honeycomb get_trace. Target ~9-11s/turn, 1 xAI POST/turn.

- [ ] **Bug — duplicated credix-agent reply** `not_started`
  On the `general`/credixAgent path, `result.text` came back with the same answer concatenated twice
  (multi-turn probe turn 2; trace 4da9d5db..., one 13.9s xAI POST). Not seen on score_improvement/credit_card.
  Candidate: `makeAgentStep` result.text assembly across the maxSteps loop for credixAgent. User-facing.

- [ ] **Latency follow-up — second CONCURRENT x.ai POST under agent.generate on some turns** `not_started`
  Trace 115eb5c4... turn 3 (credit_card): agent.generate 13.3s wraps TWO simultaneous POSTs to
  /v1/chat/completions (13.28s + 9.75s) with app.tool_calls.count=0 and om observed=false — not a
  tool loop, not OM. Suspect Mastra memory (working-memory update or a memory processor) firing a
  parallel LLM call; generate awaits both, so the slower one sets turn latency. Investigate in
  @mastra/core memory pipeline (credixMemory, schema-mode working memory); decide keep/disable/
  move off critical path. Also the remaining explanation for yesterday's 17 POSTs / 13 turns.

- [ ] **Latency follow-up (optional) — classify residual ~3s is xAI-side** `not_started`
  Intent-only cut classify 5.24s -> ~3.2s but the POST itself is 2.7-3.4s (Mastra overhead ~10ms),
  so the rest is xAI TTFB/queueing for grok-3 + strict json_schema. If it ever matters again:
  (a) restore direct chat.completions with response_format json_object (git 59153fe) to skip
  strict-schema grammar; (b) try a smaller model id for the classifier; (c) session-level intent
  reuse for short continuations. Low priority — generate dominates the turn now.

- [ ] **Cleanup candidate — getBureauProfile tool is now unreferenced by agents** `not_started`
  Kept exported in tools/bureau.ts (+ its tests) for reversibility after 9ffea32. If the Phase C
  outcome holds for a week of probes, delete the tool + tests or repurpose for the API layer.

- [ ] **Worker context cap — messageFilter slice(-20) can drop early turns** `not_started`
  The expanded credix + credit-card addenda tell workers "never re-ask what they told you", which
  relies on the master forwarding session history down on delegation (verified: Mastra default full-
  context forwarding, capped by the workflow's `messageFilter: messages.slice(-20)` in
  credix-workflow.ts masterStep). In a long chat, a fact stated >~20 messages back is invisible to
  the worker and it re-asks. If this shows up in real use: raise the slice, or replace the slice with a
  summarizing filter that keeps stated user facts (spend, categories, employment). Low priority until
  observed. Also: full-rundown replies now allowed up to 200 words (card + master addenda) only when the
  user explicitly asks; watch TTS length/latency on those turns.

- [x] **Signal engine — engine_full.py integrated as the persona signal layer** `complete` (2026-07-09)
  Upgraded user_story/signals.py to the full 62 Tier-1 + 34 Tier-2 + compose engine (engine.py,
  parity-tested vs engine_full.py over the 100-user sample), reusing the materialize -> UserStoryStore
  -> /internal/user-story endpoint chain (SIGNALS_VERSION 1->2). TS: lib/user-story-fetch.ts module
  cache + server.ts single fetch + workflowInput.signals; agent access via getSignals tool (pull) and
  a PII-safe prompt summary (push); tracing via user-story.fetch + signals.lookup spans. E2E proof +
  verify green. Spec/plan: docs/superpowers/{specs,plans}/2026-07-09-bureau-signal-engine*.
  Follow-ups: Python sidecar OTel; LLM prose user_story; add PASSPORT/VOTER/DL to mapping if wanted.

- [x] **ZT-730 — RequestContext for user_id (context-first tools)** `complete` (2026-07-29)
  server.ts builds one `RequestContext` per `/v1/chat` (user_id, channel, `MASTRA_RESOURCE_ID_KEY`),
  passed into the workflow run; masterStep forwards it to `masterAgent.generate` so delegated workers
  inherit it; `getSignals`/`getStatement`/`getBureauDetail` read context first, arg as fallback.
  Regression test in signals-tool.test.ts. Commit 901c8e1 on feat/langfuse-tracing-request-context.
  Reverses the earlier "user_id stays a tool arg" call; see the CORRECTED note in findings.md.

- [x] **ZT-729 — Langfuse AI tracing behind a key gate** `complete` (2026-07-29)
  lib/langfuse-observability.ts + index.ts wiring + SIGTERM flush in server.ts. Off unless
  LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY are both set. Two redaction passes before export
  (SensitiveDataFilter by field name, scrubIdentifiers by value). Commit fce7ad2, same branch.

- [x] **ZT-729 follow-up — capture one live Langfuse trace and decide on user_id** `complete` (2026-07-30)
  Done live against hipaa.cloud.langfuse.com. A real turn exports one trace named `credix-turn`
  with trace input/output, 43 observations, and both generations carrying model + tokens (master
  grok-4.5 5326/575, worker grok-4.20-0309-non-reasoning 6140/125). Mobile inside prompts/tool I/O is
  `[REDACTED]` as designed. user_id decision: NOT hashed. The raw mobile is the Langfuse user id by
  explicit choice (HMAC was offered and declined), so the scrub processor exempts that one field.
  Cost shows 0: Langfuse has no pricing for the grok models (see the model-pricing follow-up below).

- [ ] **ZT-730 follow-up — getBureauProfile is the one un-converted user_id tool** `not_started`
  tools/bureau.ts:28 still reads user_id from inputData only, while getBureauDetail beside it is
  context-first. It is currently unreferenced by agents (see the cleanup-candidate entry above), so
  the choice is: convert it for consistency, or delete it with its tests. Right now the file shows
  two adjacent tools with different identity rules and no comment saying why.

- [ ] **Chore — drop the remaining LangGraph deps** `not_started`
  langgraph.json and the Makefile `dev-graph` target are gone (2026-07-29), but pyproject.toml:17-18
  still pins `langgraph>=0.2` + `langgraph-cli[inmem]>=0.1` and `make install` still asks for the
  `[dev,graph]` extras. Removing them means regenerating uv.lock, so it was left out of that commit.

- [x] **Provider switch back to xAI Grok, master + worker picked from env** `complete` (2026-07-30)
  lib/provider.ts defaults are now `xai/grok-4.5` (master) and `xai/grok-4.20-0309-non-reasoning`
  (workers + OM), both overridable by MASTER_MODEL / WORKER_MODEL in .env. The GEMINI_API_KEY ->
  GOOGLE_GENERATIVE_AI_API_KEY shim stays, so `google/*` ids still work with only an env edit.
  server.ts startup warning accepts either provider key. Uncommitted at time of writing.

- [ ] **Follow-up — re-baseline turn latency on Grok** `not_started`
  One live master turn (lounge-access question, no bureau profile) took 15.3s end to end on
  grok-4.5 + grok-4.20-0309-non-reasoning, with 2 delegations. No Gemini baseline was captured in
  the same session, so it is unknown whether this is better or worse than the Gemini pair. The two
  existing latency entries above (concurrent x.ai POST, residual ~3s) were written when the app was
  on Grok the first time and are live again as suspects.

- [ ] **Langfuse model pricing for the grok ids** `not_started`
  Every generation lands with `calculatedTotalCost: 0` because the Langfuse project has no model
  definitions matching `grok-4.5` / `grok-4.20-0309-non-reasoning`, so per-turn cost is invisible.
  Fix is a `POST /api/public/models` per id with the prices from `GET https://api.x.ai/v1/language-models`
  (grok-4.5 2.00/6.00 per 1M in/out, grok-4.20-0309-non-reasoning 1.25/2.50). Not done here because
  it mutates the shared Langfuse project; needs a go-ahead.

- [ ] **Langfuse: OM Observer and TTS spans still fall outside the turn trace** `not_started`
  masterStep now forwards `tracingContext` so the master + worker + tool spans nest under the
  workflow trace. The Observational Memory Observer/Reflector runs in a background buffer and the
  compose/TTS call sits in its own step, so anything they emit is not proven to join the same trace.
  Worth a look if OM behaviour ever needs debugging from Langfuse alone.

- [ ] **PII — the raw bureau_profile is exported as Langfuse trace input** `not_started`
  Verified 2026-07-30 on a real subscriber: the trace input is the whole workflow input, which includes
  the unmasked sidecar payload (general_info, loan_details, enquiries, loan_repayments, loan_patterns,
  borrowing_window, institution_details, dpd) in plaintext, now alongside a raw-mobile user id. The
  identifier scrub only removes mobile/PAN/Aadhaar patterns, not financial data. Options: pass
  `tracingOptions.hideInput` for the workflow root, or feed the workflow the MASKED profile and let the
  raw one stay behind the sidecar boundary. Second option also shrinks prompt tokens.

- [ ] **Raw mobile as the Langfuse user id, and the scrub carve-out that keeps it readable** `not_started`
  Copilot server.ts:192 and langfuse-observability.ts:58. Deferred by the user on 2026-08-03. Both
  threads were then RESOLVED on the PR as accepted-decision (not fixed), each comment stating that in
  its first line. CONSEQUENCE: the PR no longer carries a reminder, so tasks/improvements.txt item 4 is
  the only tracker left. The code is unchanged: server.ts still exports the raw mobile and the
  processor still exempts that field. The two move together, hash at the call site then delete the
  exemption in the same change.

## PR #20 (next) — SUPERSEDED IN SCOPE by tasks/plan/plan-right-card-flow.md (2026-08-04)
The user's intent is the right-card FLOW in credix, not prompts alone. The prompt phases below are
still valid but move DOWNSTREAM of the flow work (they become Phase 7 of that plan), because the flow
decides which prompt owns which rule. Read tasks/plan/plan-right-card-flow.md first.

## PR #20 prompt phases (now Phase 7 of the flow plan) — Master and worker prompt overhaul

GOAL: fix the reply-quality defects visible in real traces, using the prompt patterns already proven
in ../right-card (sibling repo, same Mastra stack, 25 commits of prompt fixes driven by tester logs).
NOT a rewrite for its own sake: every rule added must trace to an observed defect or a right-card
commit that fixed one.

EVIDENCE ALREADY IN HAND (2026-08-03 probe, real bureau-backed turns, session d43d315f)
  - Turn 2 opened with "I'll pull the key benefits of the HDFC Swiggy BLCK for you." then restated the
    card name. Turn 3 opened with THREE filler sentences: "I'll get a clear side-by-side ... Quick
    update on your goals, then the compare. Here is a simple side by side for you."
  - Missing spaces at the joins ("you.HDFC", "spends.Quick") => the master is CONCATENATING its own
    narration with worker text, not synthesizing one reply.
  - right-card fixed this exact class: 25d06bd (strip anecdotes from model-facing text), a860d84
    (one-reply), and its front-loaded CRITICAL block already carries the rule verbatim:
    "Never announce a tool call ('let me check...') — call it silently, reply with the result."

- [ ] **Phase 1 — Defect baseline** `not_started`
  Run a fixed 6-message probe set through the real /v1/chat and record every defect VERBATIM in
  tasks/findings.md, before touching a prompt. Set: greeting, profile review, single card benefit,
  two-card compare, eligibility ask, small talk. This is the before-column; without it Phase 6 cannot
  prove the change worked. Reuse probe.local.json + TEST_MOBILE.

- [ ] **Phase 2 — Front-load a CRITICAL block in RAHUL_PERSONA** `not_started`
  right-card's bd977f8 ("front-load critical rules for attention, not just completeness") says
  ordering, not completeness, is what makes rules hold. persona.ts currently lists rules flat, with the
  no-dashes and digits rules mid-list. Add a short CRITICAL header carrying only the rules that must
  never break: no tool-call announcements, one reply, digits only, no dashes, no PAN/Aadhaar/mobile,
  never invent a figure. Full detail stays below, as right-card does it.

- [ ] **Phase 3 — Master synthesis rules (the concatenation bug)** `not_started`
  master.ts MASTER_ADDENDUM says "synthesize ONE reply" but does not forbid narrating the plan or
  pasting worker text. Add: no preamble about what you are about to do; rewrite worker output in your
  own voice rather than appending it; never restate the card or topic name the user just used; one
  reply per turn. This is the phase that fixes the observed defect.

- [ ] **Phase 4 — Worker grounding rules from right-card** `not_started`
  Port the four that apply to credix, adapted, not copied:
    a) in-generation check: about to write a rate/fee/figure with no tool call THIS turn => stop, call
       the tool first. Prior-turn context is not a substitute. (Covers hallucination_audit H1.)
    b) comparisons need this-turn data for EVERY card, not one call licensing both.
    c) if two of your own numbers disagree, re-derive from the tool result, never publish both.
    d) disambiguation turns are question-only, no data wall before the question.
  credit-card.ts already covers ambiguity and null-vs-error well; (a) and (c) are the real gaps.

- [ ] **Phase 5 — Decide what moves into code** `not_started`
  right-card's 7d6cb0c records "prompt rules lost to prompt templates": rules that must ALWAYS hold
  belong in code. Candidate: strip a leading "I'll ..." / "Let me ..." narration sentence in
  postGuardrailStep, which already strips dashes and PII. DECISION NEEDED, not obvious: a regex that
  eats a legitimate first sentence is worse than the defect. Prefer prompt-first, measure in Phase 6,
  and only add the code guard if the defect survives.

- [ ] **Phase 6 — Re-run the Phase 1 set and diff** `not_started`
  Same 6 messages, new session. Record after-column beside before-column in tasks/findings.md. A rule
  that did not change an output gets deleted, not kept "just in case": prompt tokens are paid on every
  turn, and credix already runs 34k-token prompts.

- [ ] **Phase 7 — Pin the new invariants in tests** `not_started`
  agents.test.ts already asserts each addendum is wired into instructions. Extend it to assert the
  CRITICAL lines exist verbatim, so a future edit cannot quietly drop them (right-card lost rules to
  drift; 5ab422f is literally "sync INTERNAL_INSTRUCTIONS drift").

OPEN DECISIONS (answer before Phase 2)
  1. Branch base: stack on feat/langfuse-tracing-request-context, or branch off dev? masterStep's
     prompt assembly in credix-workflow.ts is touched by BOTH PR #19 and this work, so branching off
     dev means a conflict on merge. Recommend stacking, given PR #19 is review-clean and about to land.
  2. Scope of Phase 5's code guard (see the decision note in that phase).
  3. Out of scope unless asked: intent-based tool subsetting (right-card 25d06bd). It would cut the
     credit-card agent's 12-tool surface per turn and is the most promising lead on improvements.txt
     item 2 (latency), but it is a structural change, not a prompt change.

## Right-card flow port — execution tasks (plan: tasks/plan/plan-right-card-flow.md, 2026-08-04)

Branch: feat/right-card-flow, stacked on feat/langfuse-tracing-request-context (decision in plan §0/§6:
masterStep and the workflow are touched by both, so stacking avoids a merge conflict on PR #19).

- [x] **Phase 0 — Persona battery + fix-queue** `complete` (2026-08-04, commits 4879a3e + baseline graded)
  BLOCKING. scripts/battery.ts drives scripted conversations through the real /v1/chat, logs every turn
  to scratchpad/battery-<stamp>.jsonl, and runs deterministic checks for the defect classes we already
  know about (dashes, spelled numbers, >120 words, PII, internal vocabulary leaks, tool-call
  announcements, repeated sentences, missing closing question). 5 personas: expert, newbie, lowaware,
  adversary, hinglish. Two suites: single-turn and multi-turn. Graded output lands in tasks/fix-queue.md.
  Why blocking: right-card's 34-turn battery is what proved their question-repeat defect was endemic
  (4 instances) rather than a one-off. Every later phase is measured against this baseline.

- [x] **Phase 1 — Language end to end (M5, M6)** `complete` (2026-08-04, commit 1468900). Owed: an
  after-battery to confirm D6 (inconsistent register) is actually gone; the baseline ran on pre-change code.
  lib/detect-language.ts (pure, unit-tested, no model call) + lib/language-notes.ts (hi, hinglish, ta,
  te) + switch persona/master/credit-card/credix to function-valued instructions reading
  requestContext. Largest user-visible gap: Hinglish is the default register for our users, and today
  every agent ignores it. Independently shippable, touches no routing.

- [ ] **Phase 2 — Thread state module (M10) + pending-question tracking (M2 groundwork)** `not_started`
  PARTIAL already: lib/session-state.ts landed in Phase 1 with capMapSize + sessionLanguage. Still owed:
  stickyAgent and lastQuestion maps, and postGuardrailStep recording whether the reply ends in a question.
  lib/thread-state.ts: bounded maps for stickyAgent, language {committed, pending}, lastQuestion, with
  capMapSize. postGuardrailStep records whether the outgoing reply ends with a question. In-process
  only; the file must say so, since a multi-instance deploy needs Redis (already running for bureau).

- [ ] **Phase 3 — classifyStep: regex intent + confidence + context-aware downgrade** `not_started`
  lib/intent-patterns.ts with OUR domains (credit_card, score_improvement, bureau_query, insurance,
  general, small_talk; INTENT_VALUES already sits unused in lib/patterns.ts). classifyStep runs between
  decodeStep and preGuardrailStep, no model call. Strictly additive: only confident single-domain turns
  take the new fast path, everything else goes to masterStep exactly as today, so the worst case is
  unchanged behaviour. Verify with the Phase 0 battery plus per-turn LLM-call counts from Langfuse.

- [ ] **Phase 4 — Sticky routing (M3)** `not_started`
  Ambiguous resolution stays with the agent that last held the thread. Port their ambiguity definition
  including unconditional stickiness for greeting-shaped messages, with their two live failures as test
  fixtures (bare card name answering a disambiguation; bare "Yes" answering a consent-style ask). Our
  equivalent shape: credit-card.ts asks for monthly spend, user replies "15k", must reach the same worker.

- [ ] **Phase 5 — LLM classifier fallback (M1 tier 2) + compound v3 (M4)** `not_started`
  CONDITIONAL on Phase 3/4 battery results. If regex plus stickiness already routes cleanly, delete this
  phase instead of building it. Compound goes straight to v3 (route primary, answer fully, offer
  secondary in one line); right-card's code documents why v1 and v2 failed.

- [ ] **Phase 6 — Background profile sync (M9)** `not_started`
  CONDITIONAL. Check first whether OM already captures stated facts ("I spend 15k on Swiggy") well
  enough to make a second extractor redundant. Do not build on a hunch.

- [x] **Phase 7 / Phase A — Prompt incorporation** `complete` (2026-08-04, commits ac2141b, db866c6,
  dc093b0, 27e0ce7, 28bdfc2). Measured: internal-vocab 18->5, glued-text 16->5, announce-tool 10->2,
  repeat-sentence and dash to 0, clean p50 21.8s->16.6s, D1 (CRITICAL wrong fee answer) fixed and
  verified. OWED: one more battery to measure A1b and A7, which landed after the after-run. Phase B
  (situational blocks keyed on intent) still blocked on Phase 3.
- [ ] **Phase 7 leftover — Prompt overhaul, original wording** `superseded`
  Tier 1-4 from tasks/findings.md 2026-08-04. Deliberately last: if the fast path ships, the master's
  synthesis rules matter for fewer turns and the workers' own rules matter for more.

- [x] **Phase 8 — Skills and working-practice gaps** `complete` (2026-08-04, commit 4879a3e).
  handoff + grill-me ported, fix-queue.md adopted in session-persistence.md. mastra skill skipped: the
  Mastra MCP server covers it. Frontend-only skills skipped.
  Port handoff (session-persistence.md already tells us to "run handoff skill" and it does not exist)
  and grill-me (12 lines) from right-card. Adopt tasks/fix-queue.md as a standing convention. Skip the
  frontend-only skills. mastra skill only if the Mastra MCP server proves insufficient.

## PR #20 review round (2026-08-05)

- [x] **Copilot review threads on PR #20** `complete` (2026-08-05, commit e17bb3f)
  All 3 replied to point by point and marked resolved; status reports unresolved=0. Shipped: session-state
  onto the existing ttlCache (Map insertion order is not LRU), first_year_note made purely user-facing with
  the model-facing imperative left to CREDIT_CARD_ADDENDUM, GST figures derived once, one module level inr()
  for three duplicate formatters, 4 new firstYearNote tests, comment typo. tsc clean, 313 pass 0 fail.
  Detail in tasks/progress.md 2026-08-05.

- [x] **Codex P1 + Copilot round 2 — battery jsonl persists unredacted PII** `complete` (2026-08-05,
  commit d030609). Both reviewers raised it independently. Every row now goes through scrubIdentifiers at
  the disk boundary, never before the checks (a check must see the real identifier to flag it). main() is
  argv-guarded and TEST_MOBILE moved inside it, so the file is importable and scrubRow has 5 tests.
  Landed before the next battery run, so no unscrubbed log was ever written.

- [x] **Codex P2 — sessionLanguage keyed by client-controlled session_id alone** `complete` (2026-08-05,
  commit d030609). Now `${user_id}:${session_id}`, matching how workflow memory scopes its thread id by
  user_id as the resource. CARRY FORWARD: Phase 4's sticky-routing map must use the same composite key.

- [ ] **Ponytail audit leftovers from PR #20** `not_started`
  9 remaining findings, ranked, in tasks/improvements.txt item 10. Biggest is agents.test.ts generating 18
  it() blocks for 6 assertions on one shared constant. Cheapest real one is buildSignalSummary duplicating
  plainSignals under a comment claiming one source of truth. Roughly 60 lines and 16 redundant tests total.
  Not urgent; pick them up alongside whichever file the next phase touches anyway.

- [x] **PR #20 review, all threads closed** `complete` (2026-08-05, commits e17bb3f + d030609)
  6 threads total across 2 passes and 2 reviewers, every one replied to point by point and resolved;
  unresolved=0. Nothing from the review is outstanding. The ponytail-audit leftovers (tasks/improvements.txt
  item 10) are separate and still open. PR is ready for a human pass.

## Tool-call coverage battery + Langfuse evals (2026-08-05, user request)

Goal: prove every tool actually FETCHES its details against real sources, 100 direct cases plus a ~20-turn
agent pass, with results visible in Langfuse as evals. User chose: both depths; memory wipe limited to the
live DB's memory tables.

- [ ] **Phase T0 — Wipe user memory** `in_progress`
  Back up src/mastra/mastra.db to the scratchpad, then DELETE from mastra_resources, mastra_threads,
  mastra_messages, mastra_observational_memory. Live DB is src/mastra/mastra.db (21 MB); the 1.2 MB root
  ./mastra.db is a stray from running at repo root and is OUT of scope by user choice. Baseline before:
  6 resources, 211 threads, 907 messages, 637 observations, 8 distinct users.

- [ ] **Phase T1 — 100-case direct tool matrix** `not_started`
  scripts/tool-battery.ts. Calls tool.execute(input, { requestContext }) directly, real catalog DB + real
  bureau sidecar + real Exa. 15 tools: getSignals, checkCardEligibility, exaSearch, getBureauProfile,
  getBureauDetail, calculateEmi, calculateFoir, getStatement, getCardCriteria, getCardFees,
  getCardPartnerRates, getCardBenefits, getCardDetails, compareCards, getCardFullProfile.
  Each case asserts FETCH SUCCESS, not just no-throw: named non-null fields, correct shape, and that error
  is null. A tool returning its notFound/unavailable shape counts as a FAIL when the input is known-good.

- [ ] **Phase T2 — Langfuse evals** `not_started`
  Each case becomes a Langfuse trace with a score. Decide dataset+run (experiment) vs trace+score via the
  langfuse skill rather than guessing endpoints. Must respect the existing PII posture: the scrub
  processors only run on the Mastra exporter path, so anything sent directly needs the same treatment.

- [ ] **Phase T3 — ~20 agent turns via /v1/chat** `not_started`
  Confirms tool SELECTION, which T1 cannot. Covers fees, partner rates, bureau, signals, eligibility,
  comparison, statement. Separates "tool is broken" from "model did not call it".

- [ ] **Phase T4 — Report + record** `not_started`
  Per-tool pass/fail table, every failure with the input and the actual response.

### Tool-battery results (2026-08-05)

- [x] **Phase T0 — Wipe user memory** `complete`
  src/mastra/mastra.db memory tables cleared: mastra_resources, mastra_threads, mastra_messages,
  mastra_observational_memory all 0 (were 6 / 211 / 907 / 637 across 8 users). Schema and the other 33
  tables intact. Backup at scratchpad/mastra.db.backup-222659 (21 MB) if anything needs recovering.

- [x] **Phase T1 — 100-case direct tool matrix** `complete`
  scripts/tool-battery-cases.ts + scripts/tool-battery.ts, `bun run tool-battery`. 100 cases, 15 tools, all
  inputs read from the live catalog first. Result: 92 pass, 5 fail, 0 error, 3 nodata. p50 261ms, max 2.5s.

- [x] **Phase T2 — Langfuse evals** `complete`
  lib/langfuse-eval.ts. Dataset 'credix-tool-fetch', run 'tool-fetch-20260805172808', 100 run items each
  linked to a trace carrying 3 scores (tool_fetch_ok BOOLEAN, tool_latency_ms NUMERIC, tool_verdict
  CATEGORICAL). Verified by reading it back: 92/100 scored 1, and a failing score carries its reason as the
  comment. Only a fetch VERDICT is exported, never a raw payload.

- [ ] **Phase T3 — 20-turn agent selection pass** `in_progress`
  scripts/agent-tool-pass.ts, `bun run agent-tool-pass`. Smoke run found the defect below.

- [ ] **BUG: master emits its delegation call as literal JSON to the user** `not_started` **HIGH**
  Found by the agent pass on 2026-08-05, turn a-fees-reserve ("Total first year cost of the Axis Bank Reserve
  credit card including GST?"). The reply body was a fenced ```json block containing
  [{"name":"agent-creditCardAgent","parameters":{"prompt":"User wants the total first year cost..."}}]
  so the user sees raw tool-call syntax instead of an answer. Not caught by the persona battery, whose checks
  are regexes for vocabulary/length/dashes and none of which look for tool-call JSON. Two things to do:
  add a check for a fenced json block or an "agent-" name in postGuardrailStep (code, not prompt, since this
  must always hold), and find out why the model text-emits the call instead of invoking it.

- [ ] **BUG: getCardFees ignores catalog.card.first_year_fee** `not_started` **HIGH**
  3 of the 100 cases (fees-fyf-1/2/3). The column is populated for 80 of 361 cards and CONTRADICTS the
  computed value: icici_emeralde first_year_fee=0 while we quote ₹14,160; icici_times_black 0 while we quote
  ₹23,600; icici_coral_rupay 0 while we quote ₹590; rbl_irctc 500 (joining_fee=0) while we quote ₹0. So
  free-first-year cards are quoted a full joining fee and a fee-in-year-one card is quoted as free. Wrong in
  both directions, and it is the same defect class the PR was opened to fix (ZT-763's D1). Decide which
  source wins, then make first_year_total_with_gst and first_year_note read it.

- [ ] **calculateEmi / calculateFoir output gaps** `not_started` low
  calculateEmi returns "EMI: 10403": no ₹, no Indian grouping, and no total interest or total payable, so the
  model formats money itself, which is what inr() exists to prevent. calculateFoir returns "FOIR: 75.0%" with
  no affordability band though the addendum references banding. Both computed values are correct (verified
  independently in python), so this is presentation, not arithmetic.

- [ ] **No statement for TEST_MOBILE** `not_started` low
  3 cases report nodata rather than fail: getStatement correctly returns available=false. The statement fetch
  path is therefore UNVERIFIED. Upload a statement for the test user to close the gap.
