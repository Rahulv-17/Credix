# Progress

## 2026-06-29 — Phase 11: live multi-node workflow E2E (real Grok + real bureau)

The nodes were all unit-tested in isolation and the wired path only ran with the agents mocked
(`e2e.test.ts`). Built a real end-to-end run of `credixWorkflow` with nothing mocked: real Hono
`app` -> `fetchBureau` -> live Python sidecar (Redis L1 + Mongo L2 + Snowflake L3) -> understand
(live Grok grok-4.3) -> specialist agent (live Grok + tools) -> post-guardrail -> compose.

Test: `src/mastra/__tests__/e2e.live.test.ts`, opt-in via `LIVE_E2E=true` + `E2E_LIVE_MOBILE` (numbers
supplied at run time, never committed). Covers injection-reject (deterministic, no LLM spend) and
PII-safety (one full real pass, assert no PAN/Aadhaar/mobile in the composed reply). Drove it through
the real app with `app.request('/v1/chat')`. Stood up redis-stack (ReJSON) on :6380 and uvicorn
sidecar on :8000 for the run, then tore both down.

Result: 2 pass, 13 assertions. A real credit question routed to the `score_improvement` specialist and
returned a coherent reply grounded in the real profile ("Score 900 already excellent... 0% utilization,
clean DPD, 0 enquiries... keep utilization under 30%"), digits not words, no PII.

The live run earned its keep by catching real bugs that all the mocked tests missed:
1. `GROK_API_KEY` in `.env` was a Google Gemini key (`AIza...`, valid against Google's API, 400 against
   xAI), not an xAI key. Diagnosed by probing both providers; user swapped in a valid `xai-` key.
2. `provider.ts` bound models via `grokProvider(id)`, which the AI SDK resolves to the OpenAI Responses
   API (`/v1/responses`). xAI rejects that body: 422 "did not match enum ModelInput". Fixed to
   `grokProvider.chat(id)` (Chat Completions) for both `grokModel` and `understandModel`.
3. `grok-4.3` is a valid model (it is `grok-latest`, the reasoning model), so no model-id change.
Graceful-error note: while the key/provider were wrong, the workflow never crashed; the specialist
step's API error was contained and the server returned a clean 502, no stack trace, no PII.
Minor unfixed finding: INJECTION_PATTERNS misses "ignore ALL previous instructions" (the `all` breaks
the `/ignore\s+(previous|prior)/` regex); "ignore previous instructions" and "disregard all" are caught.

## 2026-06-29 — Phase 9: bureau Python wrapper + snowflake_client hygiene (issues/005)

Researched production Python client-library patterns via Exa first (openai-python, anthropic-sdk,
stripe-python, plus several writeups), drafted `issues/005-bureau-python-client-wrapper.md`, then built.

**9a, the facade.** `src/nodes/raw_data/bureau/client.py` is now the one surface callers import:
`get_bureau_profile(mobile, *, force_refresh=False)` and `get_bureau_section(mobile, section)`, both
async, plus `_sync` twins for scripts and the sync FastAPI route. The whole resolver stack is sync
(pymongo, sync redis, snowflake), so the async functions offload it via `asyncio.to_thread` and never
block the event loop. PII is stripped centrally (`doc.pop("pii")`) so no caller has to remember.

`errors.py` (was an empty Phase-1 scaffold) now holds a typed hierarchy: `BureauError` base,
`InvalidMobile(BureauError, ValueError)`, `BureauUnavailable(layer, message)`. **Design call, a
deliberate deviation from the Phase 9 note:** the note said return None on no-record OR sidecar down.
We split them: None means a genuine miss, infra failure RAISES `BureauUnavailable`. Collapsing both
into None makes a Redis outage indistinguishable from a brand new user, and every caller silently
serves "no data" during an outage. The research is explicit on surfacing errors as data.

`partial_reads.py` (also an empty scaffold) now owns `VALID_SECTIONS` + a pure `select_section(doc,
section)` so the route, the client, and tests share one section catalog instead of the route hardcoding
the set and reaching into `redis.get_path` with raw JSONPath. `bureau_internal.py` imports the set now.

Resolver gained a `force_refresh` flag (skips L1/L2, straight to Snowflake under the lock, re-warms).

**9b, snowflake_client.py hygiene.** Made import-side-effect free: `load_dotenv` + default connection
name now resolve lazily inside `connect()` (was at module import), `print(..., file=sys.stderr)` →
`logging.debug`, and the whole CLI (`parse_args`/`run`/`main`/`__main__`) moved to
`scripts/fetch_bureau_profile.py` which imports `connect`/`SQL_BY_ID`/`SQL_TOP` from the library.
`fetch_scrub_row` (the L3 hook) unchanged in behavior, now calls `connect()` with no arg.

Verified: import of `snowflake_client` runs nothing; facade + route import clean; ruff format+check
clean on all touched files; `pytest tests/` 13 pass (9 new client cases, resolver-mocked, async driven
via `asyncio.run` since the project has no pytest-asyncio). **Not committed yet.**

## 2026-06-28 — Issue 004.3: server wiring + E2E + cleanups (Issue 004 complete)

`POST /v1/chat` now runs the real workflow end-to-end. `server.ts`: exported the Hono `app` and moved
env guards + `serve()` + signal handlers behind an `isEntry` guard
(`process.argv[1] === fileURLToPath(import.meta.url)`) so e2e can import `app` without binding a port.
Handler: `fetchBureau(user_id)` (notFound→200 record-not-found, transport→502) → single profile passed
into `mastra.getWorkflow('credixWorkflow').createRun().start({inputData})` → non-success 502, success
`{response: result.result.composed, session_id, active_skill}`.

Verified Mastra API first (docs MCP + `.d.ts`): **getWorkflow keys by the registration KEY**
(`'credixWorkflow'`), not the workflow id — the spec's `'credix-workflow'` would throw. Result
union: success has `.result`, failed has `.error`.

E2E (`__tests__/e2e.test.ts`, 8 tests via `app.request`): intent routing, injection→guardrail-reject
with 0 LLM calls, mobile-not-found, no PAN in output, session echo, 400 invalid mobile. Sidecar mocked
with node:http; agents stubbed with the shared harness — which I had to change to **extend the real
Agent**, because `new Mastra({ agents })` calls `agent.__setLogger(...)` (and other lifecycle methods) a
bare stub doesn't have. The stub now overrides only generate()/getMemory().

Cleanups: #6 hoisted `new ElevenLabsClient` above the withRetry closure (decode/compose) — one client
per call, not per attempt; #5 documented stripPii as full-profile-only and made getBureauDetail tolerate
bare-array sections (strip pii on objects, wrap arrays) — fixed the 502-on-array mis-throw; #4 tidied
`.env.example` LLM section + added `UNDERSTAND_MODEL`/`UNDERSTAND_REASONING`. Added `mastra.db*` to
`.gitignore` (LibSQL store created at runtime/tests).

Verified: `bunx tsc --noEmit` exit 0 · `bun test __tests__` = **163 pass · 9 skip · 0 fail** (was 155).
Not committed. **Issue 004 is functionally complete.** One open item: the live grok-4.3 structured-output
path is still unverified (every test mocks the agent) — needs a manual probe with a real key + sidecar.

## 2026-06-28 — Issue 004.2: workflow assembly + single-fetch bureau (built)

Assembled `credix-workflow.ts` end-to-end per the corrected spec. Chain: decode → pre-guardrail →
understand → `.branch()` (5 conditions on pre_guardrail/intent) → `.map()` collapse → post-guardrail →
memory-writeback (no-op pass-through) → `.map()` buildComposeInput → compose. `makeAgentStep` applies
maxSteps 3 + `memory{resource,thread}`, builds `tool_calls_log` from `result.steps[].*.payload.*`, and
guards empty responses. `guardrailRejectStep` shares the branch schema, no LLM.

Single-fetch: `lib/bureau-fetch.ts` (`fetchBureau`, discriminated result, closes review #3);
`pre-guardrail.ts` no longer fetches — masks `getInitData().bureau_profile`; `memory-writeback.ts`
is a no-op pass-through (memory deferred). Registered 4 agents + workflow in `index.ts`.

**Two architectural fixes made during the build (both verified, both logged to lessons.md):**
1. **Import cycle:** extracted `libsqlStore` into `lib/storage.ts`. The "declare libsqlStore before the
   agents import" idea from the prep notes is impossible — ESM hoists imports above const decls. A
   dedicated storage module that both index.ts and memory/index.ts import genuinely breaks the cycle.
2. **bun mock.module is NOT hoisted** above static imports, and the specialist agents are eager
   module-level singletons — so a static import builds them with the REAL Agent before the mock
   registers. Fix: a shared `__tests__/agent-mock.ts` harness (spreads the real module so MessageList
   etc. survive, overrides only Agent, delegates generate to a mutable state object) + **dynamic
   `await import`** of the workflow/agents AFTER `mock.module`. One generate impl serves both LLM
   touchpoints (understand reads `.object`, makeAgentStep reads `.text`/`.steps`). Also relative-path
   `mock.module('../steps/understand')` simply doesn't intercept — only bare specifiers do.

Tests: new `workflow.test.ts` (6 — routing per intent, guardrail-reject with 0 LLM calls, seams carry
session_id/active_skill, no PAN in output); rewrote agents/understand tests onto the shared harness;
updated steps.test pre-guardrail to the single-fetch contract (profile via init data).

Verified: `bunx tsc --noEmit` exit 0 · `bun test __tests__` = **155 pass · 9 skip · 0 fail** (was 149).
Not committed. Next (004.3): wire `POST /v1/chat` to the workflow, E2E tests, Sudhanshu #4/#5/#6, and a
live grok-4.3 structured-output probe (still unverified — all tests mock the agent).

## 2026-06-28 — Pre-004.2 readiness: spec verification, sequence diagrams, skill update

No code shipped — verification + docs day to de-risk 004.2 before building.

**Verified 004.2 against reality (docs MCP `docs/workflows/control-flow.md` + installed `.d.ts` +
the repo's real step schemas).** The spec's architecture is sound but had build-breaking gaps; logged
them and corrected `issues/004.2-workflow-assembly.md` in place so it's buildable on first pass:
- Branch steps must share ONE input/output schema (Mastra requirement).
- TWO `.map()` seams needed: collapse-branch → agentOutputSchema, and **buildComposeInput** before
  compose — confirmed `compose.ts` reads response/channel/session_id/active_skill from `inputData`
  (NOT getInitData), and `active_skill` is dropped at post-guardrail (`{raw_response}→{response}`).
- `tool_calls_log` must read `result.steps[].*.payload.*` (the `.payload` wrapper) or it's empty.
- Use `pre_guardrail`/`brief` (004.1's actual output), not the spec's `guardrail_ok`/`entities`.
- `libsqlStore` must be declared before the agents-barrel import (index→agents→memory→index cycle).

**Decisions (user):** memory writeback **deferred** (Postgres memory later — memoryWritebackStep stays
a no-op pass-through, no `updateWorkingMemory` in 004.2); compose fed via **`.map()` seams** (production
choice — leaves the Issue-002-tested compose.ts pure). Plan: `~/.claude/plans/pick-004-1-...md`
(rewritten as "Pre-004.2 Readiness").

**Sequence diagrams (`/sequence` skill).** Produced 4 source-derived diagrams of the whole flow
(edge POST /v1/chat; workflow pipeline; specialist agent turn; bureau resolver L1→L2→L3), annotated
implemented-vs-pending. Traced from `server.ts`, `bureau_internal.py`, `resolver.py`, and the steps.
Not yet saved to a committed doc (offered).

**Skill change.** `.claude/skills/sequence/SKILL.md`: added a no-emoji convention + anti-pattern #11
(use text tags like `[done]`/`[pending]`, not glyphs).

Open item: identity-check step is unused in the single-fetch design (identity/existence done in Hono);
grok-4.3 structured-output unverified at runtime (all 004.1 tests mock the agent).

## 2026-06-26 — Issue 004.1: building blocks + understanding redesign

Built all standalone pieces for the 004.2 credix-workflow (no assembly, no `index.ts`
registration yet — those are 004.2 deliverables by the sub-issue split).

Planning was no-shortcuts: verified the risky Mastra APIs against the **installed** `node_modules`
`.d.ts` (@mastra/core 1.45.0, @mastra/memory 1.21.0, @ai-sdk/openai 3.0.74) AND the Mastra docs MCP
before writing code, which caught three places the Issue-004 spec is wrong (now forward-flagged for
004.2 in `lessons.md`). Installed the user's requested skills (`mastra-smoke-test`,
`debugging-difficult-bugs`, `mastra`=best-practices; `mastra-hono` not published in that repo) and
used the `mastra` skill + docs MCP to ground the idioms.

Files: `agents/persona.ts` (RAHUL_PERSONA), the 4 specialist agents (real `new Agent()` on
`grokModel` + `credixMemory` + tools — closes review #4), `agents/index.ts` barrel,
`tools/eligibility.ts` (`checkCardEligibility` pure tree), `memory/index.ts` (`credixMemory`
singleton, schema-mode working memory, `scope:'resource'` over the shared `libsqlStore`),
`steps/understand.ts` (lazy `understandAgent` on grok-4.3 + structured output → `{ intent, brief }`;
kept short-circuit / fail-fast / degradation), `lib/provider.ts` (+`understandModel`).

Key implementation lesson: Mastra agents/clients must be constructed LAZILY (not at module top
level) or `mock.module` can't intercept them — bun hoists `import` above `mock.module()`. Fixed
`understand.ts` to memoise its agent inside `execute`; tested the module-level specialist agents with
the REAL `Agent` in the alphabetically-first `agents.test.ts`.

Verified: `bunx tsc --noEmit -p tsconfig.json` exit 0 · `bun test __tests__` = **149 pass · 9 skip ·
0 fail** (was 121) · standalone import smoke confirms no circular-import crash + single shared memory.
Not committed yet (awaiting user go-ahead per git-practices).

## 2026-06-26 — PR #7 finalization: commit working-tree changes to dev

Committed and pushed the outstanding `dev` working-tree changes into PR #7
(`dev → main`, Issue 002 + 003). Three focused commits:
- `164263f` api: harden global error handler — stack/PII exposed only when
  `NODE_ENV === 'development'` (was: hidden only in production).
- `ef6ba6c` docs: correct partial-mask example `98XXXX3210` (prefix=2/suffix=4)
  across pre-guardrail comment, README, agents.md, issues-2.md; move
  checkEligibility to Issue 004 in the README roadmap.
- `c197597` infra: regenerate uv.lock for the credit-credix → nodes rename.

**Verify:** `tsc --noEmit` clean; `bun test` 140 pass / 9 skip / 0 fail.
**Not staged (intentional):** `rahul-front/`, `.agents/`, `.claude/skills/`,
`temp/`, untracked `tasks/test-results-*` — local scaffolds/artifacts.
**Next:** Issue 004 on a new branch (stack off `dev`, base the PR on `dev`).

## 2026-06-23 — Issue 001: Hono + Mastra bootstrap + Python data sidecar

**Branch:** `dev`

Implemented Issue 001 — replaced the broken LangGraph Python API layer with a Hono
(TypeScript) public API + Mastra bootstrap, and demoted FastAPI to a data-only sidecar.

**Files created:**
- `src/mastra/package.json` — ESM package, pnpm scripts, all deps (`@mastra/core`, `@mastra/libsql`, `@mastra/memory`, `@ai-sdk/openai`, `hono`, `@hono/node-server`, `@hono/zod-validator`, `zod`)
- `src/mastra/tsconfig.json` — `moduleResolution: "bundler"` (required for Mastra export maps)
- `src/mastra/lib/provider.ts` — xAI Grok provider via `@ai-sdk/openai`
- `src/mastra/lib/patterns.ts` — `INJECTION_PATTERNS`, `SCOPE_PATTERNS`, PII regex, `INTENT_VALUES`, `STEP_IDS`
- `src/mastra/server.ts` — Hono server on `PORT`; startup guards for `INTERNAL_API_SECRET` and port 2024 conflict; `POST /v1/chat` stub + `GET /health`
- `src/credit_credix/api/routes/bureau_internal.py` — FastAPI sidecar routes: `GET /internal/bureau/{user_id}` and `GET /internal/bureau/{user_id}/{section}`; hardened with `resolve()` tuple unpack, `get_path()` list unwrap, `get_resolver().redis` singleton, `mobile_to_user_id()` normalization

**Files modified:**
- `src/mastra/index.ts` — rewrote 17-line TODO to real `libsqlStore` + `mastra` exports
- `src/credit_credix/api/app.py` — swapped `chat.router` → `bureau_internal.router`
- `.env.example` — added `MASTRA_DB_URL`, `PORT`, `BUREAU_SIDECAR_URL`, `INTERNAL_API_SECRET`

**Files deleted:**
- `src/credit_credix/api/routes/chat.py` — had broken import (`graph.builders` deleted); removed atomically with `app.py` change

**Verification:** `pnpm typecheck` — exit 0 (no errors); `ruff check src/credit_credix/api/` — all checks passed.

---

## 2026-06-19 — Restructure to canonical LangGraph layout (`src/credit_credix/`)

**Branch:** `restructure/langgraph-layout`.

Materialized the full `docs/architecture/repo-structure.txt` tree (157 stub files
+ package scaffolds across all 3 phases) and migrated the working Phase-1 bureau
pipeline into it via `git mv`:

- `pre-processing/pipeline/*` → `src/credit_credix/raw_data/bureau/` —
  `resolver.py`, `tokenizer.py` (was `identity.py`), `normalizer.py`;
  `repositories.py` **split** into `mongo_client.py` (`MongoRepo`) +
  `redis_client.py` (`RedisRepo`); `snowflake_source.py` + `snowflake-fetch/
  fetch_bureau_profile.py` **merged** into `snowflake_client.py` (added
  `fetch_scrub_row`). Imports rewritten to `credit_credix.raw_data.bureau.*`.
- `env.py` → `config/settings.py` (Pydantic `Settings` + dependency-free
  `load_env()` shim; behavior identical). `resolve.py` → `scripts/resolve_profile.py`.
  `scrub_mapping.yaml` → `config/`. tests → `tests/unit/`. docker-compose → root.
  `scrub_variables_320.xlsx` → `tests/fixtures/scrub_dictionary.xlsx`.
  `docs/*.txt` → `docs/architecture/`. `temp/*` → `docs/architecture/`.
  `mcp_tools.py` → `tools/_reference_mcp_tools.py`.
- Root tooling: `pyproject.toml` (src layout, deps, `graph` extra, ruff/pytest
  config), `langgraph.json` (→ `graph/builders.py:graph`, placeholder graph),
  `Makefile`, `.env.example`, `.pre-commit-config.yaml`, `docker-compose.override.yml`.
- Deleted emptied `pre-processing/ snowflake-fetch/ user-fetch-by-mobile/ temp/`.
  Kept `rahul-front/` and `tasks/`.
- Installed 4 LangGraph skills (langgraph-cli, -fundamentals, -human-in-the-loop,
  deep-agents-orchestration) — they validate, not change, the layout.

**Verify:** imports OK; `pytest tests/unit/test_identity.py` 4/4 green; CLI `--id`
matches old output; `ruff check` clean. `langgraph dev` not run (langgraph is the
`[graph]` extra, not installed). Decision = Python graph runtime; `rahul-front`
left as UI-only. **Not committed yet** (changes staged on the branch).

**`rm -rf snowflake-fetch` also removed `snowflake-fetch/keys/rsa_key.p8` (gitignored,
unrecoverable).** Low impact: active `.env` uses `SNOWFLAKE_PASSWORD` and its
`SNOWFLAKE_PRIVATE_KEY_FILE` pointed at a *different*, already-missing path. Regenerate
via `scripts/setup_keypair.sh` + re-register the public key if JWT auth is ever needed.

## 2026-06-08 — Bureau pre-processing pipeline (Redis → Mongo → Snowflake)

**Shipped the full read-through pipeline in `pre-processing/`.**

Files created:
- `staging/.env` (global: MONGODB_URI, MONGODB_DB=captain_ai, REDIS_URL, REDIS_TTL), `staging/.gitignore`
- `pre-processing/`: `docker-compose.yml`, `requirements.txt`, `README.md`, `PLAN.md`
- `pre-processing/config/scrub_mapping.yaml`
- `pre-processing/pipeline/`: `env.py`, `identity.py`, `normalizer.py`, `repositories.py`,
  `snowflake_source.py`, `resolver.py`, `__init__.py`
- `pre-processing/resolve.py` (CLI), `pre-processing/tests/test_token_parity.py`

Verified end-to-end against mobile 9944003361 (token `85bc535b…`, Oct-2025, score 900):
- Cold path → `source: snowflake`, wrote `captain_ai.bureau_data` `_id=85bc535b…:Oct-2025`.
- Warm L1 → `source: redis`; warm L2 (after DEL) → `source: mongo`, repopulated.
- PII split confirmed: absent from Redis key, present in Mongo `data.pii`.
- Agent slice `$.loan_details.PL` returns the PL block.
- `ruff format` + `ruff check` clean; token parity test passes.

Issues resolved: YAML int-key bug (`30_60`→3060), port 6379 clash (user stopped old
plain Redis), test import path.

**Out of scope / next:** optional FastAPI wrapper + Dockerfile; decide whether to
consolidate the old plain Redis vs the redis-stack instance.

## 2026-06-09 — First content commits (repo bootstrap)

Workspace is now a git repo. Staged the untracked tree as 3 concern-scoped commits
off `Initial commit` (77b2079); verify green first (ruff clean, token-parity test passes):

- `dfbaec8` beast: dev harness — `.claude/` rules/skills/agents, `settings.json`, `tasks/`, `.gitignore`
- `5d76831` beast: data-fetch utilities — `snowflake-fetch/`, `user-fetch-by-mobile/`, scrub xlsx
- `e9d0a94` beast: bureau pre-processing read-through resolver — `pre-processing/`

Excluded from git: `staging/.env` (gitignored), `.claude/settings.local.json` (machine-local),
the 15 `.claude/skills/*` symlinks (resolve outside repo) — last two added to `.gitignore`.
Pushed to origin/main.

## 2026-06-09 — Phase 8: canonical key = 10-digit mobile + 15-day window

Replaced the sha256 `mobile_to_token` with `mobile_to_user_id` (bare 10-digit mobile,
normalizes country code / `+` / spaces / leading 0; validates len 10). New key flows
through everything: JSON top-level `user_id` (was `_token`), Mongo `_id={user_id}:{scrub_month}`
+ field `user_id` + index, Redis `cc:profile:{user_id}` / `cc:lock:{user_id}` (value only).
`captain_ai`/`user_token` join dropped per user.

Added a **15-day Mongo freshness window**: `ProfileResolver(fresh_days=BUREAU_FRESH_DAYS,
default 15)`; L2 served only if `now - fetched_at < fresh_days` (fixed window from
`fetched_at`, app-level — no native TTL index, audit history preserved). Redis L1
unchanged (1-day TTL). `resolve.py --token` → `--id`.

Tests: replaced `test_token_parity.py` with `test_identity.py` (normalization +
invalid-raises + resolver freshness with fakes: fresh→mongo/no-SF, 16d→snowflake/upsert).
ruff + pytest (4) green. `RedisRepo` untouched.

**DB:** repo-root `.env` (the "staging" global) sets `MONGODB_DB=consumer`; the
`consumer` DB previously held only an empty `bureau_json`. Per user, the pipeline
writes to **`bureau_data`** (created on first write). `resolve.py` default updated
`captain_ai`→`consumer`.

**Live run — all green (2026-06-09)** against real Snowflake (password auth from
`.env`) + Atlas `consumer` + a `redis-stack` container on :6380 (the local Redis on
:6379 is plain, no ReJSON):
- Cold → `snowflake`; wrote `consumer.bureau_data` `_id=9944003361:Oct-2025`
  (top-level `user_id`, PII retained in Mongo) + Redis `cc:profile:9944003361`
  (PII-stripped, ttl ~1d).
- L1 → `redis`; L2 (after Redis DEL) → `mongo`, Redis re-warmed.
- Stale: backdated `fetched_at` 16d → re-fetched `snowflake`, `fetched_at` refreshed.
- Input `+91 99440 03361` → normalized to `9944003361`, served from cache.

**Artifacts left running:** `cc-redis-stack` container on :6380 (test instance).
**Infra gap for real use:** the pipeline needs RedisJSON, but :6379 is plain Redis —
run redis-stack on :6379 (stop the plain one) or point `REDIS_URL` at a ReJSON instance.
**Not committed yet** (awaiting user go-ahead).

## 2026-06-30 — security review of bureau python wrapper
- Installed getsentry/skills@security-review (OWASP-based) globally to ~/.agents/skills.
- Audited src/nodes/raw_data/bureau/* + api/routes/bureau_internal.py + scripts/fetch_bureau_profile.py.
- Static + adversarial probes: parameterized SQL (no SQLi), yaml.safe_load, no eval/exec/pickle/shell,
  hmac.compare_digest auth fails closed, section allowlist blocks JSONPath injection, no tracked secrets/.env/keys.
- Findings (no Critical/High): (1) MED defense-in-depth — PII strip hardcoded to literal "pii" key,
  config `secure: true` flag is unused; rename/2nd secure section would silently leak PII to Redis+callers.
  (2) LOW — internal API authz is single shared secret only (IDOR-class broad read by mobile).
  (3) LOW — mobile normalizer truncates overlong input to last 10 digits instead of rejecting.
- 23/23 bureau unit tests pass.

## 2026-07-01 — Wire interface/ (was rahul-front/) to the Mastra credix workflow

Renamed `rahul-front/` -> `interface/` and brought it under version control (source
only; `node_modules`/`.next`/`.agents`/lockfile excluded). Replaced the dead LangGraph/
"captain :8080" wiring with a real end-to-end connection to Hono `POST /v1/chat`.

- **Proxy:** `interface/app/api/chat/route.ts` forwards POST to `CREDIX_API_URL`
  (default `http://localhost:3000`) server-side. Mandatory because the Hono app has no
  CORS. Deleted the old `app/api/[..._path]` LangGraph proxy.
- **Runtime:** `lib/useCredixRuntime.ts` — `useLocalRuntime` adapter posting
  `{mobile,message,session_id,channel:'web'}`, single-shot (PII redaction happens in
  postGuardrail; no token streaming), with abort + 60s timeout + distinct error copy.
  Persists the backend `session_id` in localStorage. Deleted `useCustomLangGraphRuntime.ts`
  + `chatApi.ts`.
- **Auth:** phone-capture only (`AuthState = {mobile, sessionId}`); dropped OTP/profile
  calls to the deleted :8080. First intro bubble now comes from a real `/api/chat` seed
  call; second is static.
- **Deps:** removed all `@langchain/*` + `@assistant-ui/react-langgraph` + `concurrently`;
  deleted `backend/agent.ts` + `langgraph.json`; `dev` -> plain `next dev --turbopack`.
- **Baseline fix:** two pre-existing scaffold tsc errors (phone-input untyped subpath,
  tool-fallback React19 ElementType) fixed so the verify gate is meaningful.

**Verify:** `npx tsc --noEmit` exit 0; `npm run build` exit 0 (route map: `/` static,
`/api/chat` dynamic); dev boots in ~4s and `/api/chat` returns `502 {error:"Credix
backend unreachable"}` with the backend down (graceful path confirmed). Commits:
`2be86ba` (rename+import), `9daef40` (proxy), `999bd8b` (runtime+auth), `949a62e` (deps).

**Still pending:** full live E2E (real Grok + sidecar + a registered mobile) driving the
UI end to end — needs the backend stack up; not runnable in this session.

## 2026-07-02 — orchestration resilience (R1-R3), TDD
- R1: specialist agent.generate now wrapped in withRetry; on exhaustion returns a safe retryable
  fallback reply (agent_error marker) instead of throwing, so a Grok outage no longer 502s a turn.
- R2: compose fails soft on TTS failure — returns the spoken text + tts_failed:true instead of 502.
- R3: tts_failed threaded through workflowOutput + /v1/chat response; E2E proves specialist failure
  → 200 graceful fallback (not 502).
- R4 (harden firedBranch): deliberately skipped — the ?? collapse is correct for the guaranteed
  single-fire branch; adding a throw path would cut against the resilience goal for a defensive-only gain.
- Verified: tsc exit 0; bun test 175 pass / 12 skip / 0 fail (up from 163).
- FINDING (pre-existing, out of scope): the specialist agent.generate runs TWICE per successful turn
  (confirmed on committed code too; Mastra step engine, DEFAULT_MAX_RETRIES=1). That is a ~2x LLM
  cost/latency issue on the happy path, worth a separate investigation (e.g. step retries:0).

## 2026-07-02 — fix: double specialist LLM call (branch not mutually exclusive)
- Root cause (systematic-debugging + Mastra core read): .branch() runs EVERY branch whose condition
  is truthy (Promise.all over truthyIndexes in @mastra/core 1.45.0), not just the first. Our general
  catch-all condition was `pre_guardrail`, which overlaps every specialist intent, so score/card/
  insurance turns fired the specialist AND general (2 LLM calls; firedBranch discarded the general one).
- Evidence: instrumented step execute-entry showed two ids (e.g. score_improvement + general) per turn.
- Fix: made the general branch condition mutually exclusive (excludes the 3 specialist intents), so
  exactly one agent fires. Cuts specialist-intent LLM spend ~2x -> 1x. Idiomatic Mastra: branch
  conditions must partition the input (all docs examples use exclusive conditions).
- TDD: added routing tests asserting agentMockState.calls === 2 (understand + one specialist) for
  score_improvement / credit_card / general. tsc exit 0; bun test 178 pass / 12 skip / 0 fail.

## 2026-07-03 — Observational Memory enabled + verified live

- Enabled OM on `credixMemory` (`observationalMemory: { model: grokModel, scope: 'thread',
  observation.messageTokens, reflection.observationTokens }`), env-tunable via
  `OM_SCOPE`/`OM_MESSAGE_TOKENS`/`OM_OBSERVATION_TOKENS`/`OM_ASYNC_BUFFER`. Reuses the xAI grokModel
  as Observer/Reflector — OM's `model` accepts a LanguageModel instance, so no new provider key.
- Diagnosis loop (via `OM_DEBUG=1` -> `om-debug.log`): the auto observe-on-turn trigger never fires
  through non-streaming `agent.generate` (nor `.stream`) — `processInputStep` runs and reports
  `msgs=42/10` over threshold, but no observation results. `engine.observe()`/`engine.finalize()`
  called directly DO produce correct observations (Grok-4.3 Observer works). Root cause left as a
  framework quirk; not worth further reversing.
- Fix: the no-op `memory-writeback` step now triggers OM explicitly at end of turn —
  `engine.getStatus()` (pure read) gates an `engine.finalize()` (activate+observe) and a re-checked
  `engine.reflect()`. Fully fail-soft (never breaks a reply), instrumented under an `om.writeback` span.
- Verify: `bunx tsc --noEmit` 0; `bun test` 184 pass / 14 skip / 0 fail; live e2e
  `LIVE_OM=true bun test src/mastra/__tests__/om.live.test.ts` -> 1 pass (149s), observations e.g.
  "User introduced self as Arjun / loves cricket / wants to budget better and save for a Goa trip".
- Not committed yet.

## 2026-07-03 — Honeycomb wired to the live workflow (OTEL on every turn)
- Diagnosis: full workflow was ALREADY instrumented (credix.workflow → every step span, + bureau.fetch)
  and tracing.ts exports OTLP→Honeycomb, but the run path (`make dev-mastra`→`bun run dev`) used the
  UNTRACED `dev` script, so the SDK never booted → nothing reached Honeycomb.
- Fix: package.json `dev` now boots the SDK (`--import ./tracing.ts`); old cmd kept as `dev:untraced`.
  All entry points call `bun run dev`, so every one is traced with no other edits.
- tracing.ts: graceful degrade — skip sdk.start() (with a notice) when no OTLP endpoint/headers, so a
  traced-by-default `dev` doesn't spam connection-refused on a fresh clone/CI.
- .env/.env.example: OTEL_BSP_SCHEDULE_DELAY=2000 → spans flush every 2s for snappy live viewing.
- Verified: SDK boots ("exporting to https://api.honeycomb.io"); a real /v1/chat turn ran the whole
  workflow live (real Grok, active_skill=general); direct OTLP probe to api.honeycomb.io/v1/traces with
  the configured ingest key returned HTTP 200 (service credix-mastra). tsc 0; bun test 184 pass/0 fail.
- NOT enabled: Mastra native AI tracing (captures raw prompts+bureau data = PII leak). Custom PII-safe
  spans remain the source of truth, per the project's PII rules.
- Caveat: server.ts SIGTERM process.exit(0) can pre-empt tracing.ts's async shutdown flush → last <2s of
  spans may drop on graceful stop. Negligible for live view (runtime batch export every 2s).

## 2026-07-07 — latency fix: classifier off reasoning model + kill specialist double round-trip
- Diagnosis from a live Honeycomb trace (~21s/turn, per-turn not cold-start): understand.classify
  ~6.2s (grok-4.3 reasoning used for a 5-way intent bucket) + agent.generate ~14.7s (TWO LLM
  round-trips: agent called getBureauProfile to re-fetch data already fetched at bureau.fetch, then
  a second call to answer).
- Fix A (classifier): provider.ts UNDERSTAND_MODEL_ID default grok-4.3 -> grok-3; added
  UNDERSTAND_MODEL=grok-3 to .env. Classification with structured output does not need reasoning.
  No test impact (understand.test mocks the agent).
- Fix B (specialist double round-trip): makeAgentStep now injects the WHOLE masked_profile
  (JSON.stringify) into the prompt instead of just credit_score + section names. masked_profile
  (pre-guardrail maskProfilePii) already holds all safe sections minus PII = same data
  getBureauProfile returns, so the agent answers in ONE round-trip. persona.ts reworded lines 24-25:
  answer from the provided masked profile as primary source, tools only for genuinely-missing detail
  (was "use only what the bureau tools return", which forced a reflexive tool call). Bureau tools
  stay attached as fallback; maxSteps:3 kept for web search / statement / getBureauDetail.
- Kept grok-4.3 on the specialist (advice quality) per user decision.
- Verified: bunx tsc --noEmit exit 0; bun test 184 pass / 14 skip / 0 fail (baseline held). Not committed.
- Still to prove live (not run here): trace re-check that understand.classify drops to ~1-2s and
  agent.generate shows a single POST child (app.tool_calls.count=0 on a plain profile question),
  total ~8-11s. Run: bun run dev + one real /v1/chat turn, or LIVE_E2E=true e2e.live.test.ts.

## 2026-07-07 — live-turn probe harness (Honeycomb)
- Added src/mastra/scripts/probe-turn.ts + `bun run probe` script: sends ONE real message through
  the whole traced workflow (real Hono app -> fetchBureau -> understand -> specialist -> compose)
  and exports the trace to Honeycomb. Message/mobile live in src/mastra/probe.local.json (gitignored
  via *.json; real number = PII). Committed template: probe.local.example.json (gitignore exception).
- Probe opens a `probe.turn` root span and runs the turn in its context so credix.workflow nests
  under it; prints the trace_id to paste into Honeycomb (service credix-mastra), plus status,
  turn latency, active_skill, response. Waits OTEL_BSP_SCHEDULE_DELAY+1.5s for batch export before exit.
- Smoke-tested with a dummy number (sidecar down): tracing booted, turn returned 502 at fetchBureau
  (before any Grok spend), trace exported to Honeycomb (trace_id 4f9ad925c0424b1ade586ca387c5b133).
  Confirms the export pipeline; full workflow spans need the sidecar up + a real mobile.
- To run live: start the Python bureau sidecar (BUREAU_SIDECAR_URL=http://localhost:8000), put a real
  10-digit mobile with a bureau record in src/mastra/probe.local.json, `cd src/mastra && bun run probe`.

## 2026-07-07 — live end-to-end probe verified (latency fix confirmed)
- Ran `bun run probe` against a real number (user-supplied in probe.local.json) with sidecar live.
- Result: HTTP 200, active_skill=score_improvement, turn latency 12407ms (was ~21s pre-fix).
  Response grounded in the real profile (score 791, real utilization/card counts), PII-safe,
  digits-not-words, score bolded. trace_id 9749373f9e6113d448731082c737d622 (service credix-mastra).
- Confirms: full read path works live (decode->pre-guardrail->understand grok-3->specialist grok-4.3->
  post-guardrail->memory-writeback->compose) and the latency fix cut ~21s -> ~12s. Per-span breakdown
  (understand.classify ~1-2s, agent.generate app.tool_calls.count=0) to be read off the Honeycomb trace.
- Also added src/mastra/READ_FLOW.md: full source-derived sequence diagram + Honeycomb span tree for the turn.

## 2026-07-07 — multi-turn session probe (one conversation, one trace)
- Rewrote src/mastra/scripts/probe-turn.ts: probe.local.json now takes a "messages" array (single
  "message" string still works). All turns run sequentially on ONE session_id (generated or pinned via
  file), nested under a single probe.session root span -> probe.turn per message -> each credix.workflow.
  So the whole conversation is ONE Honeycomb trace. PII rule kept (only turn index/status/latency/
  active_skill on spans, never raw message text). Example file updated to the array shape.
- Verified live (real number, 3 turns): all 200; one trace_id 4da9d5dbbd965e86bf18069e88d15114,
  session f31483bb-c40c-47ad-9a21-bf1709d633bf. Continuity works: turn 2 ("which matters most") resolved
  against turn 1's profile list; intent routed score_improvement -> general -> credit_card across turns.
  tsc 0. Total 65s across 3 turns (grok-4.3 reasoning + growing memory context; per-turn 16-25s).
- FINDING (out of scope, worth a separate look): turn 2 (general/credix path) returned a DUPLICATED
  reply — the same answer concatenated twice in result.text. Looks like the agent's multi-step loop
  emitting two generations that both land in the composed response. Not seen on score_improvement/
  credit_card turns here. Candidate: makeAgentStep result.text assembly / maxSteps on credixAgent.

## 2026-07-07 — CORRECTION from real Honeycomb trace (honeycomb MCP now authed)
- Pulled full trace 4da9d5dbbd965e86bf18069e88d15114 (58 spans) via honeycomb MCP get_trace/get_span_details.
  Structure confirmed: probe.session -> 3 probe.turn -> credix.workflow subtrees (multi-turn probe works).
- REAL numbers contradict the earlier "12s, fix landed" (that was a best-case single turn):
  - understand.classify still ~6-7.6s on grok-3 (5.98 / 6.14 / 7.59s). The classifier model swap (Fix A)
    did NOT deliver the predicted ~1-2s. Suspect structured-output brief gen / grok-3 latency / reasoningEffort
    not honored on xAI. NEEDS INVESTIGATION — assumption in plan was wrong.
  - agent.generate still 2-3 xAI round-trips: app.web_grounding.used=true on ALL turns (EXA is enabled; the
    "skipped" log was from bun test, not the probe), app.tool_calls.count=1 on 2/3 turns, 0 on only credit_card.
    So Fix B (inject profile -> single round-trip) only fully worked on one turn.
  - Turn 2 (general/credix) had a 13.9s single xAI POST == the DUPLICATED response bug (doubled generation),
    also a latency spike.
  - Per-turn ~21s (understand ~6s + agent ~9-19s), i.e. close to the ORIGINAL problem, not the 12s claimed.
- Takeaways / open work: (1) profile the understand.classify grok-3 cost; (2) figure why specialist still tool-calls
  despite injected profile; (3) fix duplicated credix response; (4) account for the always-on Exa web-grounding POST.

## 2026-07-07 — bureau profile: fetch once per user, reuse across turns
- lib/bureau-fetch.ts: added an in-process TTL cache keyed by user_id (BUREAU_CACHE_TTL_MS default
  900000, BUREAU_CACHE_MAX 1000; only ok cached; not_found/error re-try). Transparent at the fetchBureau
  boundary (server.ts/workflow untouched). Span attr app.bureau.cache=hit|miss. clearBureauCache() test hook.
- .env/.env.example: BUREAU_CACHE_TTL_MS documented. New __tests__/bureau-fetch.test.ts (4 cases).
- Verified: tsc 0; bun test 188 pass/14 skip/0 fail. Live probe trace 209aa26b208d4898a043c34080035001:
  bureau.fetch cache miss(1)=56.97ms real HTTP, hit(2)=0.04/0.06ms no sidecar call. Fetch once, reuse. Not committed.
- CAVEAT for production: this is a WRAPPER-LEVEL (per Node process) cache. Multi-replica -> per-instance cache;
  the real fleet-wide shared cache is the sidecar's Pogocache/Redis L1 (:9401), which already made per-turn
  fetches 8-49ms. In-process cache is a micro-opt (skips intra-process network hop), not the prod caching layer.

## 2026-07-07 — SESSION SUMMARY (authoritative; consolidates + corrects the day's entries above)

Context for a cold reader: this session was a latency investigation of the live credix
`/v1/chat` turn, the observability tooling built to drive it, and a bureau-reuse change. It is
grounded in real Honeycomb traces (service `credix-mastra`, environment `test`, team
`beastoptt-gettingstarted`). The Honeycomb MCP was authorized mid-session (`plugin:honeycomb:honeycomb`
via `/mcp` OAuth), so traces can now be pulled directly with `get_trace` / `get_span_details` /
`run_query` instead of eyeballing the UI. Everything below is UNCOMMITTED on branch
`feat/bureau-python-wrapper`.

### The turn pipeline and its spans (reference)
`POST /v1/chat` (server.ts) -> `fetchBureau(user_id)` ONCE per request -> `credix.workflow`:
`stage.decode` -> `stage.pre-guardrail` (masks the passed-in `bureau_profile` via `maskProfilePii`)
-> `understand.classify` (grok classifier, intent + brief) -> `.branch()` to ONE specialist
(`agent.generate`, grok-4.3 + tools) or `guardrail-reject` -> seam `.map()` -> `stage.post-guardrail`
(PII scrub) -> `stage.memory-writeback` -> nested `om.writeback` (Observational Memory finalize/reflect)
-> seam `.map()` -> `stage.compose`. `bureau.fetch` is a SIBLING of `credix.workflow` (fetch happens
in Hono before the workflow), not inside it. Full source-derived diagram + span tree: `src/mastra/READ_FLOW.md`.

### 1. Latency fix attempt (partial success — see correction)
Original problem: ~21s/turn, all in two LLM spans. Two changes, both still in the tree:
- Fix A (`lib/provider.ts` `UNDERSTAND_MODEL_ID` default grok-4.3 -> grok-3; `.env UNDERSTAND_MODEL=grok-3`):
  move the intent classifier off the reasoning model.
- Fix B (`workflows/credix-workflow.ts` makeAgentStep: inject the WHOLE `masked_profile` JSON into the
  specialist prompt instead of credit_score + section names; `agents/persona.ts` lines 24-25 reworded to
  "answer from the provided masked profile; tools only for genuinely-missing detail"): stop the specialist
  reflexively calling `getBureauProfile` (which re-fetches data already in state), collapsing 2 round-trips to 1.
- grok-4.3 KEPT on the specialist (advice quality) per user decision.

### 2. CORRECTION — what the real multi-turn trace showed (trace 4da9d5dbbd965e86bf18069e88d15114)
An earlier single-turn run (trace 9749373f9e6113d448731082c737d622) read 12.4s and I called the fix landed.
That was a best-case single turn. Pulling the 3-turn trace via the Honeycomb MCP corrected this:
- `understand.classify` is STILL ~6-7.6s on grok-3 (5.98 / 6.14 / 7.59s). Fix A did NOT deliver the
  predicted ~1-2s. The cost is almost certainly the structured-output brief generation (intent + summary +
  2-5 points), NOT the model tier. OPEN: profile this; consider dropping the brief or splitting classify
  from brief, and re-check whether `reasoningEffort:'low'` (providerOptions key `openai`) is even honored
  by the xAI endpoint.
- `agent.generate` still made 2-3 xAI round-trips. Two causes: (a) `app.web_grounding.used=true` on ALL
  turns — Exa web grounding IS enabled (EXA_API_KEY set; the "[web-grounding] skipped" I once grepped was
  from `bun test`, not the probe) and adds one Exa POST per substantive turn; (b) `app.tool_calls.count=1`
  on 2 of 3 turns (0 only on the credit_card turn) — Fix B only fully eliminated the tool call on one path.
- Net still ~21s/turn (understand ~6s + agent ~9-19s). The latency problem is NOT solved.

### 3. Duplicated response bug (found via multi-turn probe; NOT yet fixed)
Turn 2 (general/`credixAgent` path) returned the SAME answer concatenated twice in `result.text`; in the
trace it shows as one abnormal 13.9s xAI POST. Not seen on score_improvement/credit_card. Candidate:
`makeAgentStep` `result.text` assembly across the maxSteps loop, specific to the credix agent. User-facing.

### 4. Observability tooling built
- `src/mastra/scripts/probe-turn.ts` + `bun run probe` (package.json script; boots `tracing.ts` via
  `--import`, imports the real Hono `app`, calls `/v1/chat` in-process). Input: `src/mastra/probe.local.json`
  (GITIGNORED via `*.json` — holds a real mobile = PII; template `probe.local.example.json` is tracked via a
  gitignore exception). Schema: `{ mobile, messages: string[], channel?, session_id? }`; a single `message`
  string still works (back-compat). MULTI-TURN: all messages run sequentially on ONE session_id, nested
  `probe.session` root span -> `probe.turn` per message -> each `credix.workflow`, so a whole conversation
  is ONE Honeycomb trace. Sequential so turn N's memory-writeback lands before turn N+1. PII rule: only turn
  index/status/latency/active_skill on spans, never raw message text (session_id is a UUID, safe). Prints the
  trace_id; waits `OTEL_BSP_SCHEDULE_DELAY+1.5s` for batch export before exit.
- Memory continuity CONFIRMED live: turn 2 "which of those matters most" resolved against turn 1's profile
  list; intent routed score_improvement -> general -> credit_card across the session (OM working).

### 5. Bureau profile: fetch once per user, reuse across turns (SHIPPED this session, verified)
- Root cause of per-turn re-fetch: `/v1/chat` is stateless; `server.ts:~91` calls `fetchBureau` every request;
  `fetchBureau` had NO memoization. The "single-fetch (review #3)" work was per-REQUEST dedup, never per-session.
- Change (`lib/bureau-fetch.ts`): module-level in-process cache `profileCache = new Map<user_id, {profile,
  expiresAt}>`. Read on entry (hit -> `app.bureau.cache=hit`, skip HTTP, return cached), write after an `ok`
  fetch (`app.bureau.cache=miss`). TTL `BUREAU_CACHE_TTL_MS` (default 900000ms=15m; 0 disables), size cap
  `BUREAU_CACHE_MAX` (1000, evict expired-then-oldest). ONLY `ok` cached; not_found/error/unreachable re-try.
  `clearBureauCache()` test hook. Transparent at the fetchBureau boundary — server.ts/workflow untouched.
- WHERE IT LIVES (asked): the `Map` is in the V8 heap of whatever Node PROCESS imported the module (ESM
  singleton, one per process). Not disk, not Redis, not LibSQL. Separate copy per process (Hono server, the
  probe, bun test, Mastra Studio each have their own; they don't share). Accessed ONLY through `fetchBureau`
  (read), `cacheProfile` (write), `clearBureauCache` (test). Ephemeral: gone on restart/deploy/crash.
- Verified: tsc 0; `bun test` 188 pass/14 skip/0 fail (+4 new `__tests__/bureau-fetch.test.ts`). Live probe
  trace 209aa26b208d4898a043c34080035001: `bureau.fetch` = miss(1) 56.97ms real HTTP + hit(2) 0.04/0.06ms with
  NO sidecar call. Fetch once, reuse — confirmed. `.env`/`.env.example` document `BUREAU_CACHE_TTL_MS`.
- PRODUCTION note: this is a WRAPPER-LEVEL, per-process cache. Multi-replica -> per-instance (a user's turns
  on different pods re-fetch). The real fleet-wide shared cache is the sidecar's Pogocache/Redis L1 on :9401,
  which already made per-turn fetches only 8-49ms. Recommended prod stance: keep TS stateless and let the
  sidecar L1 be the shared cache (option B); the in-process cache is a harmless micro-opt on top. Do NOT add a
  second TS-tier Redis (duplicates L1, doubles PII-at-rest). `app.bureau.cache` hit/miss is a ready cache-hit
  metric for a Honeycomb board.

### Open work (prioritized)
1. `understand.classify` ~6s on grok-3 — profile the structured-output brief cost; it, not the model, is the driver.
2. Duplicated credix-agent response (turn 2) — user-facing + a latency spike.
3. Specialist still tool-calls on 2/3 paths despite the injected profile; plus the always-on Exa web-grounding POST.
4. Commit the session's work (latency fix, probe harness, READ_FLOW.md, bureau cache) — nothing committed yet.

### Committed (2026-07-07, branch feat/bureau-python-wrapper; not pushed)
- 08e74d5  api: cache bureau profile in-process, reuse across turns
- 419e8f8  agents: inject full masked profile into specialist prompt; classifier on grok-3
- 06ed351  infra: add live /v1/chat probe harness and read-flow trace doc
- 219e330  docs: require tasks/ update after every commit or change
- (this tasks/ session log committed next, in the same ritual)
Supersedes the "Not committed" notes in the entries above. Open work items 1-3 (understand.classify
brief cost, duplicated credix reply, specialist tool-calls + Exa) remain not_started in tasks/todo.md.

## 2026-07-08 — Latency plan (tasks/plan/plan-latency-2.md) Phase A: intent-only understand.classify

Why: Honeycomb 48h aggregates (13 turns) showed understand.classify at AVG 5.24s on EVERY turn, fully
serial before agent.generate. Verified against @mastra/core 1.45.0 dist that structuredOutput without
`model` is "direct" mode (ONE POST, native json_schema response_format, no second structuring call), so
the cost is output tokens: the brief (summary + 2-5 points, ~100-200 tokens) vs ~8 tokens for intent
alone. Model tier already ruled out (grok-4.3 -> grok-3 swap, lessons.md). User approved dropping the
brief entirely; the specialist self-decomposes from raw message + masked profile + web context.

Changed:
- `src/mastra/steps/understand.ts`: llmSchema -> { intent } (flat, minimal strict-mode grammar);
  SYSTEM_PROMPT pure 5-way classification; deleted fallbackBrief; all 3 return paths (success,
  llm_<status>, llm_unreachable) emit intent only; dropped no-op reasoningEffort providerOptions;
  `res.object` cast to z.infer<typeof llmSchema> (inference widened intent to string after the schema
  shrank). briefSchema + optional `brief` field KEPT in understandOutputSchema for branch-schema
  stability and easy revert; nothing emits it.
- `src/mastra/workflows/credix-workflow.ts`: makeAgentStep dropped the dead `points` prompt block.
- Tests: understand.test.ts okObject + 3 brief assertions -> intent-only + brief undefined;
  workflow/e2e mocks stop returning briefs; persona.ts + provider.ts comments; .env.example drops
  UNDERSTAND_REASONING (dead knob), UNDERSTAND_MODEL doc updated (grok-3).

Verification: `bunx tsc --noEmit` exit 0; `bun test` 188 pass / 14 skip / 0 fail (baseline parity).
Live probe latency check comes after all phases (baseline = trace 209aa26b..., 2026-07-07 12:16 UTC).

## 2026-07-08 — Latency plan Phase B: Exa grounding runs concurrently with classification

Why: the Exa web-grounding POST (~726ms AVG over 13 turns) ran serially INSIDE agent.generate before
the main x.ai call, but it needs only the user message. Moving it into the understand step and racing
it against the classify LLM call hides its full cost under classify. User decision: keep grounding on
all substantive turns (product behavior unchanged); only bureau_query discards the result.

Changed:
- `src/mastra/steps/understand.ts`: starts `web.grounding` span + groundWithWeb(decoded_text) BEFORE
  entering the classify span (so understand.classify keeps measuring only the LLM call), Promise
  joined after classification; `web_context` attached on ALL non-blocked return paths (success + both
  degraded paths — degraded routes to general and still benefits); bureau_query discards post-classify.
  `understandOutputSchema` += optional `web_context` (verified inert across guardrailRejectStep, the
  branch conditions, and both .map() seams).
- `src/mastra/lib/web-grounding.ts`: groundWithWeb(message, span?) — intent/brief params gone,
  bureau_query skip moved to understand, buildQuery deleted (query = message), greeting/length gate kept.
- `src/mastra/workflows/credix-workflow.ts`: makeAgentStep reads `inputData.web_context ?? ''`;
  no groundWithWeb import.
- Tests: NEW shared `__tests__/exa-mock.ts` (exaMockState/exaMockFactory) — same pattern and reason
  as agent-mock.ts: tools/exa memoises its client on FIRST search, so per-file inline stubs collide
  across files (observed: understand.test received workflow.test's stub results). understand.test:
  5 new grounding tests (positive, bureau_query discard, fail-soft, zero-search on guardrail block,
  degraded-still-grounded). workflow.test: prompt-contains-web-context test. e2e.test: deletes
  EXA_API_KEY (bun auto-loads .env; a live key would make unit tests hit the real Exa API).
- `src/mastra/READ_FLOW.md`: sequence + span tree updated (web.grounding ∥ understand.classify;
  intent-only classify; agent.generate no longer wraps the Exa POST).

Verification: `bunx tsc --noEmit` exit 0; `bun test` 193 pass / 14 skip / 0 fail.

## 2026-07-08 — Latency plan Phase C: getBureauProfile detached from specialist agents

Why: 17 main x.ai POSTs over 13 turns — specialists tool-called getBureauProfile on 2/3 intents even
though makeAgentStep injects the IDENTICAL masked profile into every prompt (lessons.md: persona
wording alone doesn't suppress tool use; removing the tool is the hard fix). Each call = one extra
LLM round-trip. Safe because server.ts fetches bureau before the workflow ever runs (not_found
early-returns, transport failure 502s), so the prompt always carries the profile.

Changed:
- `agents/score-improvement.ts`, `agents/credit-card.ts`, `agents/credix.ts`: getBureauProfile
  dropped from tools; getBureauDetail KEPT (covers all 8 sections incl. general_info — the recovery
  path for anything the allowlist mask omits). insurance never had bureau tools.
- `__tests__/agents.test.ts`: expected tool lists updated.
- `tools/eligibility.ts`: stale comment (profile now injected via prompt, not the tool).
- `tools/bureau.ts` getBureauProfile export + bureau-tools.test.ts left UNCHANGED — reversible,
  flagged as dead-code candidate in todo.md.

Verification: `bunx tsc --noEmit` exit 0; `bun test` 193 pass / 14 skip / 0 fail. Probe trace check
(app.tool_calls.count = 0, one x.ai POST per turn) pending in the final verification pass.

## 2026-07-08 — Latency plan Phase D: undici keep-alive for outbound fetch

Why: every turn opened a fresh TCP+TLS handshake to api.exa.ai (22-47ms) and periodically api.x.ai;
undici's default keepAliveTimeout (4s) is shorter than the inter-turn gap. Smallest win of the plan.

Changed:
- `src/mastra/package.json`: + `undici@^6.23.0` (bun add; Node 20.20.2 bundles 6.24.1, Node 22.22.x
  bundles 6.23.0 — npm major MUST track the bundled major or the Symbol-registry dispatcher handoff
  breaks; revisit on Node 24 / undici 7).
- NEW `src/mastra/lib/http-dispatcher.ts`: setGlobalDispatcher(Agent{keepAliveTimeout: 60s,
  keepAliveMaxTimeout: 600s}) guarded with `if (!process.versions.bun)` (Bun's fetch ignores it).
- `src/mastra/server.ts`: side-effect import FIRST — server.ts (not tracing.ts) so dev:untraced and
  the probe (imports app in-process) are covered; OTel undici instrumentation is diagnostics_channel
  based, unaffected by order.

Caveat recorded in the module: a server Keep-Alive hint below 60s still wins; only the probe trace
(no tls.connect under turn-2+ spans) proves the win — checked in the final verification pass, and the
phase gets reverted if inert.

Verification: `bunx tsc --noEmit` exit 0; `bun test` 193 pass / 14 skip / 0 fail.

## 2026-07-08 — Latency plan VERIFIED live: 15-18s/turn -> ~10s warm turns

Probe: `bun run probe` (3 turns, one session) -> trace 115eb5c4d658ab83b85002fe564fe870.
Stack brought up for the run: cc-pogocache via podman (snap env needs `env -i HOME=/home/beast
PATH=$PATH podman ...` — see lessons), sidecar `uv run uvicorn src.nodes.api.app:app --port 8000`
(left running in background), probe in-process.

vs baseline trace 209aa26b (2026-07-07 12:16 UTC):
- Turn totals: 11.3 / 10.1 / 16.6s (was 18.1 / 15.2 / 16.1s). Warm-turn shape ≈ classify 3.2s +
  generate 6.6-7.3s ≈ 10s. Session 38.0s vs 49.5s.
- Phase A: understand.classify 2.9 / 3.5 / 3.3s (was 4.7-6.9s, AVG 5.24s). Target <2s NOT fully met:
  the residual is inside the xAI HTTP call itself (span ≈ POST duration; Mastra overhead ~10ms),
  i.e. server-side TTFB/queueing, not output tokens. Fallbacks stay documented (direct
  chat.completions json_object from 59153fe; maxOutputTokens cap) but not applied — classify is no
  longer the dominant term.
- Phase B: web.grounding (0.6-0.7s, used=true, results=3) starts the same tick as classify on every
  turn and is fully hidden under it; no exa POST under agent.generate anymore.
- Phase C: app.tool_calls.count = 0 on ALL turns; turns 1-2 have exactly ONE x.ai POST under
  agent.generate.
- Phase D: turns 2-3 reuse connections — zero tls.connect/dns under web.grounding, classify, and
  turn-2 agent.generate (yesterday exa reconnected EVERY turn). bureau.fetch: miss 1.05s cold
  (uvicorn just booted) then hit 0.01-0.02ms.
- Reply quality eyeballed across the 3 turns: coherent, persona-true, digits formatted, no PII,
  no duplicated text on the general/credix turn (bug not reproduced today).

NEW finding (next latency lever, out of scope here): turn 3's agent.generate = 13.3s with TWO
CONCURRENT POSTs to api.x.ai/v1/chat/completions (13.28s + 9.75s), tool_calls.count = 0 — starts
simultaneous so NOT a tool loop; om.writeback shows observed=false so NOT OM. Suspect Mastra
memory (working-memory update / memory processor) firing a parallel LLM call on some turns;
together with the removed tool-calls this explains yesterday's 17 POSTs / 13 turns. Logged as a
new todo entry.

## 2026-07-08 — Housekeeping: working tree split into 4 small commits + Session/updates.md created

User asked for the leftover changes as smaller commits: e6b75cd (interface dev port 5174, user's
own edit), aa0f37d (Issue 002 test-result docs), e715c01 (3 real project skills tracked), e729bc9
(.gitignore for .agents//.playwright-mcp//scratchpad//temp/ + skills-symlink ignore with explicit
negations for the 6 tracked skill dirs). Created `Session/updates.md` (rules reference it after
every meaningful commit but it never existed) and backfilled today's 9 commits. git status is now
clean apart from intentionally-untracked local artifacts.

## 2026-07-09 — Bureau signal engine (engine_full.py) integrated end to end

Request: port engine_full.py as a layer after bureau fetch, compute the signals, cache them so the
agent can access them, add tracing. Spec + plan under docs/superpowers/{specs,plans}/2026-07-09-*.

Two findings reshaped the design (see tasks/findings.md):
- The profile TS receives is CATEGORIZED and PII-STRIPPED (`strip_secure` drops the `pii` section),
  so a pure .ts port after fetch could not compute the ~14 Tier-1 + ~10 Tier-2 age/PAN/address
  signals. => compute server-side where PII lives (user chose this).
- An engine ALREADY existed end to end: user_story/signals.py compute_signals (~20 signals) ->
  UserStoryStore (L1 cache + L2 Mongo) -> /internal/user-story/{id} -> steps/user-story.ts (stub).
  So the work is UPGRADE + REUSE, not a parallel path.

Decisions confirmed with the user: compute in the Python sidecar; cache full tier1+tier2; expose
EXACT age + income estimates + raw score to the agent (relaxes the "PII-safe only at rest" contract
for exact age, scoped: never on a span or log); TS-side tracing now (sidecar has no OTel).

Shipped (all committed on feat/bureau-python-wrapper, verify green):
- src/nodes/raw_data/user_story/engine.py — 62 Tier-1 + 34 Tier-2 ported VERBATIM from
  engine_full.py + build_compose (gated/ranked structured list) + _to_flat (categorized->flat
  inverse of scrub_mapping; financial keys UPPER, DPD keys keep mixed case <30DPD_12mon).
- compute_signals now returns {**structural, tier1, tier2, compose}; SIGNALS_VERSION 1->2;
  store.materialize stamps signals._meta.compute_ms.
- Parity PROVEN over the real 100-user sample (tests/unit/test_signal_engine.py): every mapped
  Tier-1 + all Tier-2 match engine_full exactly. Only GLOBAL_MOBILITY_FLAG, PASSPORT_FLAG,
  KYC_DEPTH, DL_FLAG, PHONE_REACHABILITY_COUNT, and address geo diverge — all because PASSPORT/
  VOTER/DL/MOBILE columns and lossy pii lists are dropped by the normalizer (documented, expected).
- TS: lib/user-story-fetch.ts (in-proc TTL cache mirroring bureau-fetch + `user-story.fetch` span
  with compute_ms passthrough, PII-safe attrs only); server.ts fetches signals once and threads
  them into initData.signals (optional/enrichment); workflowInput += signals.
- Agent access: PULL via tools/signals.ts getSignals (reads module cache, section-narrowing,
  `signals.lookup` span) attached to all 4 specialists; PUSH via lib/signal-summary.ts injected in
  makeAgentStep (PII-safe headline summary; exact age/income NOT spelled, stay tool-pullable).
- E2E proof (src/mastra/__tests__/signals-e2e.test.ts): real /v1/chat -> mocked sidecar
  (bureau + user-story) -> workflow; asserts the specialist prompt carries the summary (push) AND
  getSignals reads exact age 41 from the warm cache after the request (pull).

Verify: ruff format+check clean on src/; pytest 81 passed / 9 skipped; bun test 210 pass / 0 fail /
14 skip; tsc --noEmit clean. Also fixed a pre-existing lint in src/nodes/api/app.py (separate commit).

Follow-ups (out of scope, noted in spec): Python sidecar OTel + traceparent propagation for a real
signals.compute span; LLM prose user_story render; add PASSPORT/VOTER/DL to mapping if those signals
are wanted; root engine_full.py is now redundant (kept as the parity oracle for the test).

## 2026-07-10: Cred integration plan drafted (planning only, no code)

Request: in-depth plan to incorporate Cred/ flows into Credix/, turning Cred's "nodes" into
TOOLS here (credit-card may stay an agent, everything else is tools), WITHOUT adding nodes to the
credix workflow pipeline (per the node diagram in docs/architecture/credix-nodes.md).

Researched Cred fully (part1-4 docs + agent/src + filtering/): it is a standalone Mastra credit-card
recommender with a proxy (regex intent + intentAgent + resolveSkill + profile-inject + SSE +
profile-sync), 5 agents, ~18 tools, and a Supabase Postgres card catalog + eligibility SQL engine,
plus its own auth/memory/UI. Map recorded in tasks/findings.md.

Deliverable: docs/superpowers/plans/2026-07-10-cred-into-credix.md (286 lines, dash-clean).
Governing principle: keep Credix's orchestration, import only Cred's domain depth.
- STAYS same architecture: the node pipeline, understand->branch routing, the existing
  creditCardAgent as the single home, the data-layer-behind-tools pattern, identity (user_id),
  Observational Memory, Compose channels, persona/provider/guardrails/tracing.
- MOVES to tools on creditCardAgent: getCardDetails/Fees/Benefits/EarnRate/PartnerRates/Criteria,
  compareCards, recommendCard, explainEligibilityFunnel, routeSpend. Reuse existing exaSearch +
  checkCardEligibility + bureau/signals (do not duplicate Cred's exa/bureau tools).
- MUST NOT become a node / not imported: Cred's intent detector + intentAgent, resolveSkill,
  profile-injection node, profile-sync node, the Express proxy + SSE translation, Firebase auth,
  libSQL memory, client threads, and the 4 extra agents (collapse into creditCardAgent;
  generalCredit -> existing general/score agents). UI cards + persisted spend deferred (out of
  pipeline). Card catalog moves as a data layer (Credix-owned Postgres, queried via a client like
  bureau-fetch). Build phases 0-5 defined; nothing built yet.

Recorded in tasks/todo.md (Phase 13). No verify run (docs + planning only, no code changed).

## 2026-07-13: Cred incorporation sequenced by dependency (planning)

Session goal (user directive): plan the incorporation "start by the easier ones with less
dependency, then plan the ones with proper dependencies." Deliverable is an execution-ordering plan
on top of the 2026-07-10 architecture blueprint.

Grounding done this session (read, not assumed):
- Credix tool conventions: tools/{eligibility,signals,bureau}.ts, agents/{credit-card,
  score-improvement,persona}.ts, __tests__/agents.test.ts. Confirmed createTool+zod, fail-soft
  returns, PII-safe tracer spans, user_id as a tool-input field (NOT Cred's requestContext.pid).
- Cred source: agent/src/mastra/lib/{db,cards,tool-context}.ts + tools/get-card-criteria.ts +
  filtering/schema/{catalog,eligible_cards}.sql + sources/*. Confirmed the reward math is SQL-only
  (~29KB, migrations-deep) and cannot be a JSON snapshot or a TS reimplementation.

Key finding that drives the ordering: there is ONE root dependency, the card catalog data layer, and
ALL 10 incorporate tools sit behind it. The only genuinely zero-dependency work is agent
instructions using tools that already exist. So:
- WAVE 1 (Tier 0, ship now): a single commit adding CREDIT_CARD_ADDENDUM to creditCardAgent
  (sourced card facts via exaSearch, approval-odds framing, own-report behaviour). No catalog, no
  decision, no forward reference to a not-yet-built tool.
- WAVE 2 (Tiers 1+2): gated on 3 decisions (catalog hosting / access shape / spend capture);
  sketched as phases 2A-2E, to be detailed after the gate.

Deliverables:
- docs/superpowers/plans/2026-07-13-cred-incorporation-sequenced.md (Wave 1 bite-sized TDD; Wave 2
  gated sketch; dependency map; global constraints; self-review).
- tasks/findings.md: 2026-07-13 code-level dependency map section.
- tasks/todo.md: Phase 14 (Wave 1 not_started; Wave 2 gated).

No code changed yet; no verify run (planning only). Next action: execute Wave 1 (one commit), settle
the 3 Wave-2 gate decisions, then plan Wave 2 in detail.

## 2026-07-13: Cred tool integration begins (getCardCriteria) [uncommitted]

User directive: skip Wave 1 (instruction addendum), go straight to tool integration, easiest first,
and report .env additions. Took the low-friction gate path (reversible): reuse Cred's Supabase
catalog directly via a direct pg Pool, rather than standing up a Credix-owned DB or an
endpoint+client first.

Shipped (not committed; git rule = commit only when asked):
- `bun add pg @types/pg` (pg@8.22.0). bun.lock updated.
- `src/mastra/lib/catalog-db.ts`: lazy `getCatalogPool()` (memoised, null when DATABASE_URL unset so
  a fresh clone / bun test never crashes), `resetCatalogPoolForTests()`, `CATALOG_DB_UNAVAILABLE`,
  ported SSL opt-ins (DB_SSL_CA / DB_SSL_VERIFY; default TLS-on-unverified for the Supabase pooler),
  pool 'error' listener (idle-client-drop recovery, from Cred db.ts).
- `src/mastra/tools/card-catalog.ts`: `getCardCriteria` ported from Cred get-card-criteria.ts to
  Credix conventions: fail-soft `{ ok:false, message }`, PII-safe `catalog.criteria` span
  (counts/outcomes only), numeric columns cast `::float8` so pg returns numbers (numeric-as-string
  would fail the zod outputSchema). DROPPED on port: makeProgress/writer.custom, card-web-fallback
  (agent uses exaSearch on a miss), toModelOutput (agent narrates structured result).
- `src/mastra/agents/credit-card.ts`: attached getCardCriteria (tools now
  getBureauDetail/checkCardEligibility/exaSearch/getStatement/getSignals/getCardCriteria).
- `src/mastra/__tests__/card-catalog.test.ts`: 6 tests, pg mocked by bare specifier + lazy-pool
  reset. `agents.test.ts` tool-list updated.
- `.env.example`: new "Card catalog" section (DATABASE_URL + DB_SSL_* opt-ins).

Verify: `bunx tsc --noEmit` exit 0 · `bun test` 216 pass / 14 skip / 0 fail (was 216 baseline; +6
new, no regression). Lessons added (pg numeric->string float8 cast; pg mock + lazy pool pattern).

.ENV TO ADD (repo-root .env): DATABASE_URL (copy from Cred/.env,
the Supabase Postgres string). Optional: DB_SSL_CA or DB_SSL_VERIFY=1 to verify TLS. Without
DATABASE_URL the card tools fail soft; the rest of the app is unaffected.

Next: port Cred `catalog-cards.ts` (fuzzy matcher) once, then getCardDetails / getCardFees /
getCardBenefits (they use cardMatchSql); then math/compare; then Tier-2 ranking + spend.

### 2026-07-13: LIVE smoke test of getCardCriteria (VERIFIED against Cred's Supabase catalog)

Ran getCardCriteria via node+tsx with the repo-root .env loaded (throwaway script, since removed).
DATABASE_URL wired by user. Real catalog rows returned, confirming the whole path end to end:
- "Regalia" -> 2 rows: "HDFC Regalia Credit Card" (accepting_new_applications=FALSE, grandfathered,
  other fields null) + "HDFC Regalia Gold Credit Card" (income_floor 150000, score_floor 700,
  ntc=false, fee 2500, fx 0.02, ifd 50, accepting=true).
- "Atlas" employmentType=salaried -> "Axis Bank Atlas Credit Card" (income_floor 100000 = the
  SALARIED column, fee 5000, fx 0.035, accepting=false).
- "Millennia" -> "HDFC Millennia Card New" (income_floor 35000, score_floor 700, fee 1000).
- "zzz-nonexistent-card" -> ok:false with the exaSearch hint.
Confirms: ::float8 casts return JS numbers (not strings); the CASE income-floor selector honours
employmentType; the grandfathered flag surfaces; LIKE partial match + fail-soft no-match both work.
getCardCriteria is live-verified, not just unit-mocked.

## 2026-07-13: Cred catalog reads batch 2: matcher + getCardFees/PartnerRates/Benefits [uncommitted]

Continued the low-friction tool integration (user: "integrate other tools too", easiest first).
Ported the shared fuzzy matcher once, then the three fact tools that build on it.

Shipped (not committed):
- `src/mastra/lib/catalog-cards.ts`: Cred's catalog-cards.ts ported VERBATIM except the db accessor
  (now `getCatalogPool()` from catalog-db) and extensionless imports. Exports the read-tool matchers
  (cardMatchSql, resolveCardCandidates, editionAmbiguity, issuerMatches) plus the ranking helpers
  (loadCategories, rankCardsForInterview, resolveCode*) kept for recommendCard later (unused by reads).
- `src/mastra/tools/card-catalog.ts`: added getCardFees (catalog.card), getCardPartnerRates
  (catalog.card_partner_rate; 3 modes card_all/partner_all/card_partner), getCardBenefits
  (card_benefit + card_lounge + network_tier_benefit + fuel-waiver synthesis). All fail-soft,
  PII-safe spans (catalog.fees/partner_rates/benefits), numeric-string cols parseFloat'd, no-match
  points to exaSearch. DROPPED on port: makeProgress, card-web-fallback, toModelOutput.
- `agents/credit-card.ts`: creditCardAgent now has getBureauDetail, checkCardEligibility, exaSearch,
  getStatement, getSignals, getCardCriteria, getCardFees, getCardPartnerRates, getCardBenefits.
- `__tests__/card-catalog.test.ts`: upgraded the pg stub to a SQL-text `responder` (multi-query
  tools) + 10 new tests (fees GST/parseFloat/not-found/db-error, partner 3 modes, benefits lounge
  synthesis + parseFloat). agents.test.ts tool list updated.

Verify: tsc 0 · bun test 226 pass / 14 skip / 0 fail (was 216; +10, no regression).

LIVE smoke (real catalog, throwaway script removed):
- getCardFees("Infinia") -> HDFC Infinia Metal Edition, joining/annual 12500 (+GST 14750), fx 0.02,
  interest 0.0199/mo, other_matches surfaced Tata Neu variants (edition ambiguity works).
- getCardPartnerRates({card:"Infinia"}) -> card_all, 0 rows (REAL: Infinia's accel rates are modeled
  as CATEGORY rates, not partner rows, not a bug; the tool returns empty correctly).
- getCardPartnerRates({partner:"amazon"}) -> partner_all, 5 cards (ICICI Amazon Pay 5%, ..., Axis
  Vistara 10% is_instant_discount=true flagged).
- getCardBenefits("Atlas") -> 5 benefits across lounge/welcome/milestone/fuel; lounge + fuel-waiver
  synthesized from card_lounge / card columns; grouping works.

FOLLOW-UP (quality, not yet done): the Cred toModelOutput narration-correctness rules were dropped
on port (year-one fee = joining only; insurance covers are limits, never summed into value; "up to"
for maximums; instant-discount != reward points; edition-ambiguity disclosure). These must move into
the creditCardAgent instructions (the deferred addendum) before these tools are user-facing-correct.

Next tools: getCardDetails (7 tables, the aggregator) + compareCards; then math (earn-rate,
route-spend); then Tier-2 ranking (recommendCard/funnel) + the instruction addendum.

## 2026-07-13: Cred catalog reads batch 3: getCardDetails + compareCards [uncommitted]

Completed the READS tier. All 6 catalog read tools now live on creditCardAgent.

Shipped (not committed):
- `tools/card-catalog.ts`: added getCardDetails (PRIMARY aggregator: catalog.card + 5 parallel reads
  = card_category+spend_category earn rates, base-tier card_lounge, card_benefit milestone/golf,
  card_transfer_partner, card_transfer_cap) and compareCards (2-3 cards, per-card fees/earn/
  welcome+milestone/lounge/eligibility; each card resolves independently, a miss gets its own error).
  Added a shared `toNum()` helper (pg numeric->string coercion) used across both. Dropped on port:
  makeProgress, card-web-fallback, toModelOutput.
- `agents/credit-card.ts`: creditCardAgent now has 11 tools (5 pre-existing + getCardCriteria,
  getCardFees, getCardPartnerRates, getCardBenefits, getCardDetails, compareCards).
- `__tests__/card-catalog.test.ts`: +6 tests (details aggregation/coercion/not-found/db-error;
  compare two-card/partial-miss/db-unavailable). agents.test.ts tool list updated.

Verify: tsc 0 · bun test 232 pass / 14 skip / 0 fail (was 226; +6, no regression).

LIVE smoke (real catalog, throwaway script removed):
- getCardDetails("Infinia") -> HDFC Infinia Metal, 14 earn rates, 1 milestone, 22 transfer partners,
  lounge dom+intl unlimited, fx 0.02 dcc 0.01, score_floor 750 invite_only=true, populate=complete,
  edition-ambiguity surfaced Tata Neu variants. All ::numeric coerced to numbers via toNum.
- compareCards(["HDFC Infinia","Axis Atlas"]) -> 2 results: Infinia (super, 12500, unlim lounge) vs
  Atlas (premium, 5000, 8 dom lounge/yr); per-card earn-rate sub-queries populated.

STATUS: catalog READ tier COMPLETE (6/10 incorporate tools). Remaining:
- Math: getCardEarnRate (43KB), routeSpend (15KB); catalog reads + reward math.
- Tier 2: recommendCard and explainEligibilityFunnel need ranking SQL + spend capture; funnel/eligible
  also need rewiring (Credix doesn't populate usr.user_profile/user_spend).
- 3 bureau rewires (bureau-report-summary/eligibility-check/eligible-cards) onto Credix bureau+signals.
- QUALITY GATE (still open): move dropped toModelOutput narration-correctness rules into
  creditCardAgent instructions before these tools are user-facing-correct.

## 2026-07-13: Catalog tools: live e2e + tool-correctness + regression [uncommitted]

Added a gated live test and verified all 6 catalog read tools work through the REAL agent/pipeline.
File: src/mastra/__tests__/card-catalog.live.test.ts (gated LIVE_CATALOG=true; run in isolation
because sibling files mock.module pg/agent/exa for the whole process).
Run: `LIVE_CATALOG=true bun test --env-file=../../.env __tests__/card-catalog.live.test.ts --timeout 150000`.

Part A: full credixWorkflow (decode->pre-guardrail->understand->branch->creditCardAgent->
post-guardrail->memory->compose) with a SYNTHETIC bureau profile (incl. pii) injected via inputData,
no sidecar. Both turns: active_skill=credit_card, grounded composed reply (₹12,500 fee, 2% forex,
780 score echoed; Infinia vs Atlas compare), and NO PAN/Aadhaar in output (post-guardrail scrub OK).

Part B: per-tool correctness via creditCardAgent.generate (mirrors makeAgentStep; tool calls pulled
from result.steps). RESULT: all 6 tools fired and returned real catalog data:
  criteria->getCardCriteria, fees->getCardFees|getCardDetails, benefits->getCardBenefits,
  partner-rates->getCardPartnerRates (ICICI Amazon Pay 5%), details->getCardDetails (SBI Cashback),
  compare->compareCards. Final result: 8 pass / 0 fail (113s).

FINDINGS (behavior, not tool bugs):
1. First run 7/8: the criteria Q (Axis Atlas, null score_floor) made the agent over-call
   (getCardCriteria->exaSearch->getCardCriteria), hit maxSteps:3, empty final text. Tool was correct;
   workflow masks empty text with a fallback. Scoped the test to assert tool-fired+returned-data
   (hard) and treat empty text as a warning. Motivates the instruction addendum.
2. A stale rerun looked like 6 failures (tools=[]); actually OM memory leaking across runs from
   stable thread keys; the agent answered from run-1 memory. Fixed with a per-run nonce
   (live-${Date.now()}-${label}). Both findings recorded in lessons.md.

REGRESSION: `bunx tsc --noEmit` 0 · `bun test` 232 pass / 22 skip (14 + 8 gated live) / 0 fail.
No regression from the 11-tool creditCardAgent.

STATUS: 6/10 catalog tools DONE + live-verified end to end. Uncommitted. Still open: math tools
(earn-rate, route-spend), Tier-2 (recommend/funnel + spend + usr rewire), 3 bureau rewires, and the
instruction addendum (now doubly motivated by finding 1).

## 2026-07-13: Two PRs opened (bureau first, then stacked credit-card)

Tests before PRs: getCardCriteria matcher fixed (contiguous LIKE -> cardMatchSql token match, so
"Axis Atlas" matches "Axis Bank Atlas Credit Card"; live-caught). Regression tsc 0 / bun test 232
pass; live suite 8/8.

- PR #14 (bureau): feat/bureau-python-wrapper -> main. https://github.com/financebuddha/credix/pull/14
  61 commits / 171 files (FRIDAY v1: signal engine, specialist workflow, bureau data layer, interface,
  latency/observability). Pushed the 35 unpushed commits first. Large by design; main was behind.
- PR #15 (credit-card, ZT-597): feat/cred-catalog-tools -> feat/bureau-python-wrapper (STACKED).
  https://github.com/financebuddha/credix/pull/15  2 commits / 19 files: catalog data layer + 6
  read tools + tests + issue 006 + plans/docs. Base is the bureau branch so the diff is ONLY the
  catalog tools. Closes #13 when the chain reaches main.

Left uncommitted intentionally (unrelated to either PR): .gitignore (tech-doc entry),
.claude/skills/tech-doc/, docs/architecture/signal-engine.md. Current branch: feat/cred-catalog-tools.

## 2026-07-13: PR #14 Copilot review resolved (co-review), commit fd07737 on feat/bureau-python-wrapper

Worked all 14 Copilot threads on PR #14. Committed the 6 real fixes to the wrapper branch (NOT cred,
so the PR reply SHAs are real), then replied + resolved every thread. Status now 14 total / 0 unresolved.
- P2 (2 threads, one root cause): duplicate Mongo pools. MongoRepo.__init__ now takes a shared
  MongoClient instead of building its own from a URI; factory.py builds one MongoClient and passes it to
  both the user_story collection and MongoRepo (one pool per process, matching the "one Mongo client"
  docstring). scripts/resolve_profile.py updated to the new signature (needed `from pymongo import MongoClient`).
- P3: compose.ts TTS fallback logs only err.name/status, never err.message (defence-in-depth).
  OBSERVABILITY.md PII section now distinguishes default vs the OTEL_CAPTURE_IO opt-in.
- P4: OBSERVABILITY.md script/path fixes (dev:traced -> dev, ../.env -> ../../.env).
- 8 Radix threads dismissed as false positives: project uses the radix-ui meta-package (namespace API),
  not the individual @radix-ui/react-* packages Copilot assumed; `tsc --noEmit` on interface/ = exit 0.
Verify: ruff clean on the 3 py files, `tsc --noEmit` in src/mastra = exit 0.
Branch mechanics: cred-catalog (PR #15) is stacked on wrapper and did NOT get fd07737, so it will pick
up these fixes on its next rebase onto wrapper (the 5 files were identical across both branches).

## 2026-07-13: Honeycomb audit of PR #14 fixes + follow-up PII fix (commit e9f5544 on wrapper)

Audited fd07737 against live credix-mastra telemetry (env `test`, 61 req / 18 workflows / 7d).
Findings: the 2 OBSERVABILITY.md doc fixes are the only Honeycomb-observable ones and both match live
data (stage.compose carries zero I/O attrs so OTEL_CAPTURE_IO is off by default; process.command_args
literally shows `--env-file-if-exists=../../.env` + `dev` script, confirming the P4 path/script fix). No
PII on credix.workflow/bureau.fetch/stage.* spans; the mobile-in-URL undici suppression works (no
url.full anywhere). The Mongo + compose-log fixes are not observable in Honeycomb (Python sidecar not in
this dataset; console.warn is a log, not a span) so they were verified by code + ruff/tsc/bun-test.

Real gap found while auditing and FIXED (e9f5544): lib/otel.ts `recordError` called
`span.recordException(err)` raw, writing exception.message/stacktrace unscrubbed, bypassing the PII rule
the I/O-capture path already enforces. recordError wraps every stage failure, so a thrown error echoing
user input could land a mobile/PAN on a span. Fix: run err.message and err.stack through the existing
`scrubIdentifiers` before recordException. Test added in __tests__/otel.test.ts (mobile + PAN in an error
message/stack are redacted). Verify: otel 5/5, full non-live suite 233 pass / 0 fail, tsc 0. Same stacked-
branch handling as fd07737 (committed to wrapper; cred picks it up on next rebase).

## 2026-07-14: PR #14 Copilot re-review rounds (commits 13173df + dc2a218 on wrapper)

Each push to PR #14 triggers a fresh Copilot pass; worked two more rounds. All on feat/bureau-python-wrapper
(PR #14); cred (PR #15) inherits on next rebase. PR #14 now 23 total / 0 unresolved.

Round 3 (13173df) - user framed it as "no OAuth, so these data paths are the only thing protecting user
data; harden them":
- tracing.ts: undici ignore-hook widened from /internal/bureau/ to all /internal/ so the user-story
  sidecar call (/internal/user-story/<mobile>, added this PR) no longer leaks the mobile into
  url.full/url.path on an auto span. Real PII leak.
- factory.py: get_resolver() was an unsynchronized singleton called via asyncio.to_thread, so concurrent
  cold start built multiple resolvers + MongoClients (undoing fd07737). Fix: extract _build_resolver(),
  guard with a double-checked threading.Lock. Concurrency regression test in test_bureau_factory.py
  (20 racing threads build exactly once; build mocked, no live services).
- Deferred at user's request (production hardening, not data-safety): STT upload cap, OM env NaN.

Round 4 (dc2a218) - user said "close the issues", so also did the two deferred ones:
- factory.py: dropped the internal "ponytail:" marker from the lock comment (Copilot flagged as jargon).
- test_bureau_client_live.py: docstring + skip reason said RedisJSON REDIS_URL; corrected to plain RESP
  (cache migrated to CacheRepo/Pogocache).
- interface/package.json: pinned @assistant-ui/react ^0.14.5 + react-markdown ^0.14.0 off "latest"
  (interface/ has no committed lockfile by design, so caret pins are what bound versions).
- interface/app/api/stt/route.ts: STT_MAX_BYTES cap (default 10 MB), 413 via Content-Length precheck +
  post-parse file.size check.
- memory/index.ts: posInt() guard for OM_MESSAGE_TOKENS / OM_OBSERVATION_TOKENS (empty/non-numeric/<=0
  -> default, not NaN).
Verify: ruff clean, bureau unit 2 pass/1 skip, mastra tsc 0, interface tsc 0. NOTE: interface files are
committed biome-nonconformant (space-indented, biome wants tabs) already, so biome isn't gating; matched
the file's space style rather than tab-convert the whole file.

Also this session: added a line to .claude/skills/co-review/SKILL.md step 3 pointing the fix step at the
ponytail:ponytail-audit skill (uncommitted, sitting with the other cred WIP).

## 2026-07-14: README full rewrite (commit 7b4afab on cred / PR #15)

Rewrote root README.md end to end, grounded in source via 3 parallel Explore surveys (Python data
plane, TS mastra layer, interface + catalog) + own reads of signal-engine.md, app.py, Makefile,
pyproject, .env examples. Old README stopped at Issue 004 and called L1 "RedisJSON on redis-stack:6379".
New doc covers FRIDAY v1 as shipped: architecture (TS Mastra/Hono + narrow Python bureau sidecar;
noted the large src/nodes scaffold is NOT wired), request pipeline, bureau data layer (plain RESP
Pogocache :9401, resolver Redis per-user lock, 15-day window), signal engine (62+34+compose, push via
signal-summary + pull via getSignals), 4 agents + tool matrix, Cred catalog (Postgres pg, 6 read
tools, Phase A done), observability, memory, interface (Next.js 16 :5174, assistant-ui non-streaming,
4 proxy routes), error handling, quickstart (make dev), env tables, conventions, roadmap.
Accuracy notes honored for the cred branch: described the resolver Redis lock (factory threading lock
is wrapper-only, not on cred), documented STT with no size cap (cap is wrapper-only), cache as plain
RESP per cache_client.py (not the stale RedisJSON test docstrings still on cred). No em/en dashes,
numbers as digits. SKIP-VERIFY (docs-only).

## 2026-07-14: PR #14 audit (ponytail + agentic-engineering) + ttlCache dedup/NaN fix (97c7258)

Ran a full audit of PR #14 (feat/bureau-python-wrapper, 74 files) on request. Two lenses:

Ponytail audit (over-engineering only, 3 parallel Explore readers over TS lib/tools, TS
steps/workflow, Python). 10 findings, net ~-72 lines / 0 deps. Ranked biggest first:
1. user-story-fetch cache machinery was a byte-for-byte copy of bureau-fetch (shrink).
2. decode.ts script-based language detection (LANG_RANGES/detectLanguage/langMap/`language` field)
   is dead: nothing downstream reads `language` (delete).
3. peekUserStory redundant with fetchUserStory's own cache check (yagni) NOTE: kept, see below.
4. understand.ts briefSchema/`brief` field dead since intent-only redesign (delete).
5. resolver.py 3 repeated L1-read blocks -> `_l1()` (shrink).
6. credix-workflow.ts first seam `.map` returns tool_calls_log/active_skill no consumer reads.
7-9. Python single-caller params: engine.build_compose `allow_needs_retest`, MongoRepo `collection`,
   engine `_to_flat` `cfg` (all yagni).
10. compose.ts `?? false` dead (schema already `.default(false)`).
Confirmed lean (no cut): http-dispatcher, otel, provider, signal-summary, web-grounding,
memory/index, eligibility, all agents, tracing, server, factory, cache_client, normalizer, store,
signals.py, app.py. Signal-engine tier lists are distinct real features, not duplication.

Agentic-engineering check (agent runtime vs the skill's rubric): decomposition STRONG (single-purpose
workflow steps, mutually-exclusive branches); error boundaries STRONG (understand degrades to
`general`, specialists fail-soft, withRetry on 5xx/429, degraded/error_code surfaced);
cost/latency GOOD (maxSteps:3, intent-only classify, concurrent web grounding). GAP: model routing by
tier is a seam only, UNDERSTAND_MODEL_ID and GROK_MODEL_ID both default to grok-3 (deliberate latency
choice, documented in provider.ts) so the narrow classifier pays specialist-tier cost. Eval: regression
strong (13 TS + 4 Python suites incl. signal-engine parity oracle), capability eval absent (no
golden-answer / LLM-judge on agent responses). Minor cost note: credix-workflow.ts:81 still
pretty-prints the masked profile into every specialist prompt.

ACTED (highest-leverage cut that also closed correctness threads): extracted src/mastra/lib/ttl-cache.ts
(`ttlCache<T>()` + `envInt()` non-negative-int env parser) and deduped bureau-fetch.ts +
user-story-fetch.ts onto it. envInt fixes the Number()->NaN class (a non-numeric BUREAU_CACHE_MAX etc.
became NaN, so `size >= NaN` was always false and the map grew unbounded); 0 stays valid so the
`*_TTL_MS=0` disable still works. Kept peekUserStory (finding #3) because signals-tool.test asserts it
reads cache WITHOUT fetching; only its internals were deduped. envInt is deliberately distinct from
memory/index.ts `posInt` (OM tokens require >0; TTL must allow 0). Added __tests__/ttl-cache.test.ts
(NaN fallback + eviction bound). Commit 97c7258 on feat/bureau-python-wrapper.
Verify: mastra tsc 0, full bun test 224 pass / 14 skip / 0 fail.

Closed 4 Copilot threads on PR #14 (two NaN threads per file from two Copilot passes: user-story-fetch
3577294810/3577457613, bureau-fetch 3577294845/3577457659), each replied citing 97c7258.

Branch note: the fix lives on PR #14's branch; cred (feat/cred-catalog-tools, PR #15) is stacked on an
older base so its working-tree bureau-fetch/user-story-fetch still show the pre-refactor copies. Cred
inherits ttl-cache.ts + the guard on its next rebase onto feat/bureau-python-wrapper.

Remaining PR #14 unresolved threads (7, NOT touched, awaiting user direction): web-grounding.ts:60/:63
(raw user message forwarded to Exa, a real user-data-safety finding despite the earlier "ignore 1" call;
plus err.message logging), signal-summary.ts:37 (slice-before-filter can emit < maxBullets),
interface/app/api/stt/route.ts:36 (server proxy still hardcodes audio.webm filename; client side was
already fixed), READ_FLOW.md:33 and :87 (doc drift: shows a `pii` block that strip_secure drops, and a
`+ user_id` in prompt assembly that makeAgentStep does not inject), signals-e2e.test.ts:134 (misleading
test name, earlier "ignore 9").

## 2026-07-15: PR #15 Copilot co-review (waves 1+2) + PR #14 linearize-onto-dev rebase

### PR #15 (feat/cred-catalog-tools) Copilot re-review, resolved to 0 unresolved
All 6 prior threads were already resolved last session, and Copilot had NOT seen the fix commits,
so re-requested a fresh review on head 51b3385 via GraphQL requestReviews(botIds:[copilot bot], union:true).
Each push auto-triggers a new Copilot review, so two waves landed:

Wave 1 (commit 56d9020, "harden card-catalog read tools"), 6 threads, all ponytail-audited as real:
- getCardDetails lounge `network` made nullable in BOTH the pg row type and the zod output schema;
  catalog.card_lounge.network is nullable (getCardBenefits already types it string|null and null-guards
  it), so a null-network row was failing zod output validation and throwing, breaking fail-soft.
- getCardPartnerRates: error returns derive `mode` from request shape (reqMode computed once from
  inputs: card+partner=>card_partner, partner-only=>partner_all, else card_all); inputs validated before
  the pool check so a bad request returns the input error even when the DB is down.
- compareCards: lounge_spend_required picks the MIN gate among gated rows (was arbitrary first via find
  on an unordered query), reusing attachLounge()'s reduce pattern in lib/catalog-cards.ts.
- card-catalog.test.ts StubPool.query params optional (= []) to match pg.Pool.query.
Verify: card-catalog 22 pass; full suite 236 pass; tsc 0.

Wave 2 (64f743c correctness + e5ae41a docs), 5 threads:
- `tier NOT IN ('gold','platinum')` was dropping tier=NULL base-lounge rows via SQL three-valued logic
  in all 3 "base tier only" queries (getCardDetails, compareCards, attachLounge). Base rows ARE stored
  with tier=NULL (getCardBenefits orders `tier NULLS FIRST` and formats null tier as base, no tier
  filter). Fixed all 3 to `(tier IS NULL OR tier NOT IN ('gold','platinum'))`. 64f743c.
- Documented DB_SSL_INSECURE in .env.example and added a DB_SSL_* row to the README env table
  (buildSslConfig reads it; prod refuses to start unless CA/VERIFY/INSECURE is set). e5ae41a.
Verify: full bun test 236 pass; tsc 0.

Each thread got a reply (ponytail finding + fix + file:line) before resolving; never resolved silently.
Wave-3 poll timed out (~12 min, no new Copilot review) => loop CONVERGED. PR #15: total 17, unresolved 0.

### Wave 3 (later same day): 6 more Copilot threads on the doc + test hardening commits, resolved to 0
Copilot posted 6 new threads after the intervening pushes (total 41, unresolved 6). All handled:
- 3 em/en-dash separators in git content (git-practices.md:14): tasks/progress.md, tasks/todo.md,
  docs/superpowers/plans/2026-07-13-cred-incorporation-sequenced.md. Fixed ONLY this PR's NEW lines
  (heading date separators => ':'; prose => ','/';'/rephrase). The whole cred doc is new so it is now
  fully dash-clean; pre-existing headings in progress.md/todo.md were left untouched (unrelated churn).
- 2 live-test logging leaks (card-catalog.live.test.ts Part A + Part B): already fixed in 3af4c92
  (LIVE_LOG_FULL gate, metadata-only default). No code change; replied citing that commit.
- 1 real fix: lib/catalog-db.ts resetCatalogPoolForTests() only dropped the cached ref, leaking a real
  pg.Pool's connections. Now best-effort `pool.end().catch()` before clearing, guarded by
  `typeof end === 'function'` so the StubPool (no end) is skipped. Added 2 checks in catalog-db.test.ts
  (closes+rebuilds a lazily-built real pool offline; no-op when nothing cached).
Verify: catalog-db 6 pass; full bun test 255 pass / 22 skip / 0 fail; tsc -p src/mastra clean.

### Wave 4 (later same day): 4 more threads, root-caused into 2 classes, resolved to 0
Copilot posted 4 new threads (total 45, unresolved 4), all in docs/config (no code):
- Machine-specific absolute paths in committed docs: swept the whole class (only 2 lines repo-wide
  matched `/home/beast` in new-in-PR content, both flagged). cred-into-credix.md:15 now says "the
  `Cred/` repository"; progress.md:895 now says "repo-root .env". `Cred/.env` (relative) kept.
- em/en dashes in new prose/config: fixed the flagged lines PLUS same-file siblings so the files stop
  re-triggering. tasks/findings.md (4 new-in-PR lines: 2 headings => ':', 2 prose => ','/';') and
  .env.example:49 (';'). Left untouched by design: .ts source comments + LLM-instruction strings
  (never flagged across 4 waves; the dash rule targets commit/PR/doc prose, not code) and pre-existing
  dash lines not in this PR's diff (unrelated churn). No verify run (docs/config only, no code changed).

### PR #14 (feat/bureau-python-wrapper) linearized onto dev
Sudhanshu asked to "rebase properly once". Diagnosis: branch was CLEAN/mergeable into dev with all 54
threads resolved; the only issue was ONE merge commit (4ff8735 "Merge origin/dev") making history
non-linear. Branch was 0 behind dev, 4 behind main (the Issue-004.x work that landed on main
separately; rebasing onto main would collide across 166 files, so NOT that). User chose linearize-onto-dev.
Method: `git rebase -X theirs origin/dev` (auto-resolve overlap toward the branch) + one manual
rename/delete resolution (redis_client.py -> cache_client.py, kept the branch's rename). 78 -> 77 linear
commits (merge commit gone; c8c65e6 doc commit auto-dropped as already-upstream). SAFETY GATE: the final
tree is byte-identical to the pre-rebase tip 9216d11 (tree-hash equality), so content is provably
unchanged and no re-test was needed. Force-pushed with --force-with-lease => head 47d9fac. Branch now
77 ahead / 0 behind dev, 0 merge commits. Did NOT reply to Sudhanshu on the PR (offered; awaiting user OK).

WIP on feat/cred-catalog-tools (Claude-line removal in rules/skills + new architecture docs +
tech-doc skill) was stashed during the rebase detour and restored cleanly; still uncommitted,
pending user decision.

### PR #15 (feat/cred-catalog-tools) rebased onto the new bureau base; conflicts cleared (2026-07-15)
After PR #14 was linearized+force-pushed last session, PR #15's base branch
(feat/bureau-python-wrapper -> 47d9fac) had all its signal-engine/bureau commits rewritten under new
SHAs. GitHub then saw PR #15 as CONFLICTING/DIRTY: every one of those ~57 rebased commits looked like a
divergent change against the copies still in cred-catalog-tools. Root cause = rebased base, not real
content conflict. Diagnosis: `git cherry -v origin/feat/bureau-python-wrapper HEAD` marked only 10
commits `+` (the genuine catalog work + the tasks-doc commit); everything below `6d63800` was `-`
(patch-identical, already in the new base). Fix: `git rebase --onto origin/feat/bureau-python-wrapper
6d63800 HEAD` replayed exactly those 10 commits onto the current base with ZERO conflicts. WIP stashed
(-u) before and popped after, restored intact. Verify on the rebased tree: tsc 0, bun test 252 pass / 0
fail (274 total, 22 skip = live/EXA-key). Diff vs base is now catalog-only (tools/tests + README +
.env.example + architecture/issue/tasks docs), no signal-engine churn. Backed up old PR tip as branch
`backup/cred-catalog-pre-rebase-2026-07-15` (-> e5ae41a) before pushing. Force-pushed with
--force-with-lease: e5ae41a...64fc229. PR #15 now MERGEABLE/CLEAN, 10 commits. Local-only d381fa1 (tasks
memory) rode along into the PR as the 10th commit (was not previously on origin). WIP on the branch
(Claude-line removal in rules/skills, next.config, SETUP, plans, + tech-doc skill + architecture docs)
still uncommitted, still pending user decision.

### PR #15 co-review loop wave 1 (2026-07-15): 5 Copilot threads -> 0
After the rebase+force-push, Copilot re-reviewed and posted 5 threads. 4 were the same root cause:
README.md:303, credix-nodes.md:129 + :296, and plans/2026-07-10-cred-into-credix.md:9 all linked
`docs/architecture/signal-engine.md`, which was untracked WIP. Fix (05134ae): committed the doc (286
lines, complete, all its own source links resolve) so every link resolves at the root; left decode.md
untracked (unreferenced, still the user's deferred decision). 5th thread (card-catalog.test.ts:28): a
top-level `process.env.DATABASE_URL='postgres://test'` was redundant (getCatalogPool is lazy, import
doesn't trigger it, beforeEach sets it per test) and leaked process-wide into other suites; removed it
(2eee39b). Verify: tsc 0, bun test 252 pass / 0 fail. Both pushed; all 5 threads replied + resolved
(status total 22, unresolved 0). Polling for a wave-2 re-review (baseline 2026-07-15T06:49:31Z).

### PR #15 co-review loop wave 2 (2026-07-15): 1 thread -> 0
Copilot re-reviewed after the wave-1 push (07:35:58Z), 1 thread on card-catalog.ts:106. Real bug:
getCardCriteria selected accepting_new_applications raw into a required z.boolean() output field, but
the column is nullable (ordering uses `accepting_new_applications IS NOT FALSE`). A NULL row would fail
Mastra output validation and throw past the try/catch, breaking the fail-soft contract. Fix (f141492):
`COALESCE(accepting_new_applications, true)` (only explicit FALSE = grandfathered, matches ordering) +
a SQL-text guard in the unit test. getCardCriteria is the only tool that RETURNS this column; siblings
use it only in ORDER BY where NULL is safe, so the fix is localized. Verify: tsc 0, bun 252 pass / 0
fail. Pushed; thread replied + resolved (unresolved 0). Polling for wave 3 (baseline 07:35:58Z).

### PR #15 co-review loop CONVERGED (2026-07-15)
Wave-3 poll timed out (~12 min, no Copilot review newer than 07:35:58Z) and unresolved=0 => loop
converged (stop conditions 1 + 2 both met). Session waves: 5 -> 1 -> 0. Fix commits: 05134ae (docs:
signal-engine.md), 2eee39b (test: env-leak), f141492 (agents: accepting_new_applications COALESCE).
Every thread replied before resolve. PR mergeable/clean. Note: signal-engine.md was committed to fix
broken links; decode.md + the other WIP (rules/skills/next.config/SETUP/plans/tech-doc) remain
uncommitted, still the user's commit-or-discard decision.

### PR #15 co-review wave 4 (2026-07-15): base retargeted to dev; re-rebased, 3 stale-base threads -> 0
After wave-3 convergence I re-triggered Copilot (user asked to trigger a review after resolution). The
new review (08:26:41Z) posted 3 threads, but they were all downstream of a base change: PR #15's base
had been retargeted from feat/bureau-python-wrapper to dev (bureau merged into dev under new SHAs),
while this branch was still stacked on the old bureau tip (47d9fac). So the PR went CONFLICTING (90
files) and Copilot re-reviewed the bureau code that leaked into the three-dot diff. Findings:
understand.ts:104 (Exa-before-intent) and tracing.ts:53 (ignoreRequestHook) were byte-identical to dev
(verified) => already-merged bureau code, out of scope; scope thread correctly flagged the bloat. Fix:
same phantom-conflict pattern as PR#14->#15 earlier. git cherry origin/dev HEAD => 13 unique (+), 77
dup (-). `git rebase --onto origin/dev 47d9fac` (zero conflicts) => diff now catalog-only (23 files,
understand.ts/tracing.ts absent). Verify tsc 0, bun 252/0. Backed up old tip as
backup/cred-catalog-pre-devrebase-2026-07-15 (f141492); force-pushed with lease (f141492...6547810,
user-confirmed). All 3 threads replied (honest out-of-scope reasoning) + resolved (unresolved 0). PR
now base=dev, MERGEABLE, status BLOCKED (branch-protection reviews/checks, not a conflict). Re-triggered
Copilot; polling for wave 5 (baseline 08:26:41Z).

### PR #15 co-review wave 5 (2026-07-15): 3 threads (2 real, 1 declined) -> 0
First review of the clean catalog-only diff (post dev-rebase). (1) card-catalog.ts:882 + (2) :955:
getCardDetails declared eligibility.invite_only as required z.boolean()/boolean but the column is
nullable (getCardCriteria already models it boolean|null); a NULL row would fail output validation and
break fail-soft. Same class as the wave-2 accepting_new_applications bug. Fix (42c7cd4): made both the
output schema and the query row type nullable, matching getCardCriteria (pass NULL through as unknown,
not coerce to false). compareCards unaffected (compareSummary has no invite_only; zod strips it).
(3) README:541 dash convention: DECLINED as reviewer misread. The rule is "no dashes AS SEPARATORS"
(em/en dashes or ' - '), not a ban on hyphenated compounds; verified README has zero U+2014/U+2013 and
zero ' - '. Rule is deliberate + enforced (git-practices.md), applies to docs by design; did not weaken
it to agent-output-only. Replied with the distinction and resolved. Verify tsc 0, bun 252/0. unresolved 0.

### PR #15 co-review wave 6 (2026-07-15): 2 threads -> 0
Review 08:44:31Z (landed just after wave-5 poll window). (1) catalog-cards.ts:71: issuerMatches
docstring over-claimed abbreviation handling ("SBI"); only 'amex' has an alias, rest is two-way
substring. Reworded docstring to match reality (no behavior change). (2) card-catalog.ts:912:
getCardDetails not-found shape hardcoded invite_only=false; loose end from the wave-5 nullable change,
now null (unknown) on the error path. Fix 345aa15. Verify tsc 0, bun 252/0. unresolved 0. Re-triggered
Copilot; polling wave 7 (baseline 08:44:31Z).

### PR #15 co-review wave 7 (2026-07-15): 2 threads -> 0
Review 09:23:35Z. (1) SECURITY, card-catalog.ts: all 5 catch blocks (getCardCriteria/Fees/Benefits/
Details/compareCards) interpolated the raw pg err.message into the model-facing return, which the model
can echo to the user; pg strings can carry hostnames/TLS/auth/connection details. Fixed at the root
with a shared dbErrorMessage(err) helper: logs detail via console.error, returns a generic
"temporarily unavailable" message. The 3 DB-error tests flipped to assert NO leak + generic message.
(2) card-catalog.ts benefit_type description omitted redemption + concierge from VALID_BENEFIT_TYPES;
filled it. Fix d322f4e. Verify tsc 0, bun 252/0 (537 expect). unresolved 0. Note: getCardPartnerRates
has no try/catch (a DB error there would throw, not fail soft) - NOT flagged this wave, logged as a
follow-up. Re-triggered Copilot; polling wave 8 (baseline 09:23:35Z).

### PR #15 co-review wave 8 (2026-07-15): 2 threads -> 0
Review 09:34:11Z. (1) CORRECTION to the wave-7 note: getCardPartnerRates DOES have a try/catch (it uses
`catch (e)` + a local err(reqMode, msg) helper, which is why the wave-7 grep for `catch (err)` /
`error: \`DB error: ${err...` missed it). It was still leaking the raw pg error (card-catalog.ts:497).
Now routes through dbErrorMessage(e) like the other five, plus a dedicated no-leak regression test in the
getCardPartnerRates describe block. So all 6 catch blocks are now safe. (2) README:490 DB_SSL_* row said
"production refuses to start"; getCatalogPool is lazy, so the app boots and only the first catalog query
fails. Reworded to say exactly that. Fix 4632f4a. Verify tsc 0, bun 253/0 (540 expect). unresolved 0.
LESSON: do not assert absence from a narrow grep; getCardPartnerRates used a different catch var + helper.
Re-triggered Copilot; polling wave 9 (baseline 09:34:11Z).

### Issue 006 doc enrichment (2026-07-15): Phase C + D implementation notes
Dependency-checked the remaining Cred tool ports and folded the findings into
`issues/006-cred-catalog-tools-integration.md` (no code change). Findings added under each phase:
- Phase C: `recommendCard` is a near-port (db.ts->catalog-db.ts, issuerMatches from catalog-cards.ts both
  ported; drop tool-context getPid/makeProgress, read income from getSignals, user_id as trusted input).
  `explainEligibilityFunnel` is a REWRITE not a port: Cred filter-funnel.ts pulls unported `lib/cards.ts`
  (getFunnel/getEligibleCards/headlineFor) which reads usr.user_profile/usr.user_spend (tables Credix
  never fills); rebuild over catalog.rank_cards_for_spend + signals; share one spend-capture loop with
  recommendCard.
- Phase D: all 3 bureau tools are REWRITES not ports. Cred bureau-eligibility-check.ts imports the whole
  Cred bureau stack (bureau-client, bureau-store, eligibility-model.ts 27KB, tool-context) which is
  explicitly NOT brought in; rebuild on Credix getBureauDetail/getSignals + pure-rule
  checkCardEligibility fed by getCardCriteria, do not reimplement eligibility-model scoring in TS.
  bureau-report-summary stays instruction-level (Phase E), no new tool.
Verified against actual imports in Cred/agent/src/mastra/tools/{recommend-card,filter-funnel,
bureau-eligibility-check,spend-router,card-earn-rate}.ts. Next cleanest step remains Phase B (math tools).

### Issue 006 deps list + Phase C correction (2026-07-15)
Created `tasks/issue-006-deps.md`, a dependency-ordered implementation guide for the 7 remaining tools
(Phases B/C/D), verified against actual Cred tool imports + ported Credix lib helpers.
CORRECTION to the earlier Phase C note: `recommendCard` is NOT a "near-port" of Cred recommend-card.ts.
recommend-card.ts imports the pid path (getEligibleCards/getUserSpend/getFunnel from the UNPORTED
lib/cards.ts, over usr.* tables Credix never fills). Credix already ships the replacement,
`rankCardsForInterview()` in lib/catalog-cards.ts:444, which calls the param-based
catalog.rank_cards_for_spend($1,$2::jsonb,$3) directly. So recommendCard is a thin createTool WRAPPER
over that existing helper + a conversational spend-capture loop; no cards.ts port. explainEligibilityFunnel
builds on the same helper (totalEligibleCount + filter stages). Issue 006 Phase C note corrected to match.
Phase B tools (getCardEarnRate, routeSpend) are the cleanest: all catalog-cards.ts deps already ported,
only card-web-fallback dropped. Recommended build order in the deps file: B(earn,route) -> spend loop ->
recommendCard -> funnel -> D bureau rewrites.

## 2026-07-16: getCardFullProfile tool + creditCardAgent strengthening (PR #16, stacked on #15)

New branch feat/full-card-profile-agents off feat/cred-catalog-tools (PR #15 head); draft PR #16
opened with base feat/cred-catalog-tools. Two changes, credit-card path only (score/insurance/
credix agents deliberately out of scope, per user).

- getCardFullProfile (src/mastra/tools/card-catalog.ts): one "everything about a card" tool that
  merges getCardDetails + getCardBenefits + getCardPartnerRates. The 3 granular tools stay. Naming
  follows the getCard* family (renamed from an earlier getFullCardProfile, which broke the prefix
  convention). Production shape, not a patch:
  - Extracted getCardDetails' inline output into a named cardDetailsOutput schema (single source of
    truth); getCardFullProfile output = cardDetailsOutput.omit({insurance}).extend({benefits,
    benefits_grouped, partner_rates}).
  - Resolution anchored on getCardDetails (fuzzy match + edition ambiguity); its resolved card_id is
    fed to the other two (exact id) so all three sections describe the SAME card. Benefits + partner
    run in parallel after the id resolves.
  - runCatalogTool(tool, input, schema) adapter: Mastra types Tool.execute loosely (optional value,
    widened return), so cross-tool calls lose the type. The adapter invokes execute once and
    schema.parse()es the result, so the value is validated at the boundary (a direct .execute call
    skips Mastra's own output validation) AND typed via z.infer. The one necessary cast is isolated
    there. benefitsView/partnerRatesView parse only the consumed subsets.
  - Fail-soft inherited from getCardDetails: DATABASE_URL unset -> CATALOG_DB_UNAVAILABLE; miss ->
    found:false + exaSearch hint. PII-safe span catalog.full_profile.
- creditCardAgent (src/mastra/agents/credit-card.ts): CREDIT_CARD_ADDENDUM appended after
  RAHUL_PERSONA (catalog-first then exaSearch, never memory; null field => not published; disclose
  edition ambiguity; no repeat calls; approval odds via checkCardEligibility+getSignals; insurance
  limits != earnable value), and getCardFullProfile wired into its tools (11 -> 12).
- Tests: agents.test.ts (tool set includes getCardFullProfile; instructions contain the addendum;
  other 3 agents do not). card-catalog.test.ts (getCardFullProfile merge via a shared SQL-routing
  responder, not-found fail-soft, DATABASE_URL unset). Full suite 260 pass / 22 skip / 0 fail; tsc
  -p src/mastra clean.
- Spec: docs/superpowers/specs/2026-07-16-card-full-profile-tool-design.md.

GOTCHA (recorded in lessons): the GitHub branch-rename REST API closes open PRs instead of
retargeting them (unlike the UI rename). Renaming feat/full-card-profile-agents mid-flight closed
PR #16; reverted the branch name and reopened #16. Rename branches with open PRs via the UI, or
close+reopen deliberately.

## 2026-07-16: Master-worker supervisor (intent router -> master node) [feat/master-supervisor]

Converted the routing middle of credixWorkflow from a deterministic intent-classify + 5-way branch
into a Mastra supervisor. New branch feat/master-supervisor off feat/full-card-profile-agents (PR #16),
so it stays out of the getCardFullProfile PR. Grounded in the installed Mastra 1.45 docs
(docs-agents-supervisor-agents.md; agent networks are deprecated in favor of supervisor agents).

What changed:
- NEW agents/master.ts: masterAgent (supervisor). `agents: { creditCardAgent, credixAgent }` (the two
  workers), `tools: { exaSearch }` (master pulls web only when it lacks info), grokModel, credixMemory,
  instructions = RAHUL_PERSONA + MASTER_ADDENDUM (understand -> delegate to 1..N workers -> synthesize one
  reply; persona rules; digits/dash-free/PII-safe/<=120 words).
- workflows/credix-workflow.ts: removed understandStep and the 4 makeAgentStep specialist steps; added
  masterStep (calls masterAgent.generate with maxSteps:5 + memory{resource,thread} + delegation.messageFilter
  slice(-20)); branch is now 2-way [ !pre_guardrail -> guardrailRejectStep, pre_guardrail -> masterStep ];
  firedBranch = reject ?? master; compose-map error_code = master's agent_error (understand_error gone). New
  shared branch-input schema routeInputSchema = pre-guardrail's output. Retained fail-soft + withRetry +
  PII-safe span 'agent.generate' (records delegated workers).
- REMOVED steps/understand.ts (classifier + web-grounding prefetch), agents/score-improvement.ts,
  agents/insurance.ts. credixAgent now absorbs score + insurance questions (it is the generalist with
  bureau/signals/statement tools). index.ts registers masterAgent + creditCardAgent + credixAgent.
  patterns.ts adds STEP_IDS.MASTER.
- Tests: deleted understand.test.ts; rewrote workflow.test.ts + e2e.test.ts for master routing (active_skill
  'master', one agent call per turn, guardrail-reject + not_found paths, master retry/fallback resilience);
  agents.test.ts smoke set = card + credix + master; patterns.test.ts 12 -> 13 step IDs.
Verify: full bun test 241 pass / 22 skip / 0 fail; tsc -p src/mastra clean.

Worker context best practice (from the supervisor doc): Mastra forwards the master's full context to
workers on delegation, so the masked profile + signals injected into the master prompt reach the workers
automatically; messageFilter is the PII/size boundary; memory isolation keeps worker chatter off the
session thread. memoryWritebackStep (Observational Memory trigger) is UNCHANGED and keeps working: it keys
on user_id/session_id, and masterStep persists the turn to the session thread via the memory option.

Follow-ups (not done): messageFilter is size-cap only (content PII scrub deferred; masked-profile injection
+ post-guardrail already bound the risk); latency deliberately left alone per user (maxSteps:5, verify on
Honeycomb later); OM_SCOPE stays 'thread' (cross-session observations remain an opt-in flag). Dead constants
left in place (INTENT_VALUES, STEP_IDS score/insurance/understand keys) to keep the diff contained.

## 2026-07-16: Switch models to Gemini (master + workers + OM) [feat/master-supervisor]

Moved the app off xAI Grok to Google Gemini, keyed on GEMINI_API_KEY (per user). Verified live via
direct REST generateContent: gemini-3.1-pro-preview -> "pong" (2.3s), gemini-3.5-flash -> "pong" (1.3s).

- lib/provider.ts: removed grokProvider/grokModel/@ai-sdk/openai. Gemini via Mastra's built-in model
  router (string form "google/<model>"). Mastra's google provider reads GOOGLE_GENERATIVE_AI_API_KEY,
  so a one-line shim forwards GEMINI_API_KEY -> GOOGLE_GENERATIVE_AI_API_KEY at import (no .env file
  read, secret never hardcoded). MASTER_MODEL_ID = google/gemini-3.1-pro-preview (env MASTER_MODEL),
  WORKER_MODEL_ID = google/gemini-3.5-flash (env WORKER_MODEL). Removed dead understandModel earlier.
- master.ts -> MASTER_MODEL_ID; credit-card.ts + credix.ts -> WORKER_MODEL_ID.
- memory/index.ts: Observational Memory Observer/Reflector now WORKER_MODEL_ID (was grokModel), so the
  whole app is single-provider (GEMINI_API_KEY only); GROK_API_KEY no longer used anywhere.
- Agent.model and observationalMemory.model both accept the router string (same MastraModelConfig type);
  tsc clean. Tests mock the Agent so no live model call in the suite. Full bun test 241 pass / 0 fail.

Note: Gemini model ids came from a live ListModels against GEMINI_API_KEY (39 generateContent models).
The Mastra provider-registry (gateway list) does NOT list google, but @mastra/core bundles the google
provider natively, so "google/<id>" resolves against generativelanguage.googleapis.com directly.

## 2026-07-16: Expand worker addenda (credix + credit-card) + full-rundown word-cap exception [feat/master-supervisor]

Installed the user's two expanded prompt addenda (verbatim) and fixed a word-cap interaction the change
exposed. Persona (persona.ts) untouched; both addenda still append with `\n\n`.

- credix.ts: extracted the inline greeting text into an exported `CREDIX_ADDENDUM` (mirrors
  CREDIT_CARD_ADDENDUM so agents.test.ts can assert it). New content = silent-analysis order (getSignals
  compose first), urgent/opportunity/context sort, 4-point cap, per-tool routing, data-distrust rules
  (income < ₹15k, util out of 0-100%, FOIR 0.0 gap), EMI/affordability math bands, and situation
  playbooks. Also dropped two stale comments referencing deleted files (score-improvement.ts,
  makeAgentStep) and reworded the header to describe the credix's current worker role.
- credit-card.ts: replaced CREDIT_CARD_ADDENDUM with the expanded version (tool discipline unchanged;
  added "ask before you recommend" gating, "convert marketing into money" math, behavioral truths,
  situation playbooks). Stable test markers preserved ("getCardFullProfile", "not published"). Also
  fixed the stale score-improvement.ts comment reference.
- WORD-CAP EXCEPTION (design decision, NOT in the user's paste but required for it to work): the master
  synthesizes the final reply and both the persona AND MASTER_ADDENDUM cap it at 120 words, so a 200-word
  worker rundown would be recompressed back to 120 at synthesis. Added a matching "up to 200 words only
  when the user explicitly asks for a full/complete card rundown" exception to BOTH credit-card.ts and
  master.ts (MASTER_ADDENDUM synthesis line). Card-addendum-only, as originally suggested, would have been
  silently broken.
- agents.test.ts: added a credixAgent addendum suite (present-after-persona with markers "section
  compose" + "under 40% of take-home income"; and only-credix-carries-it). Existing credit-card
  addendum suite still green.
- Verify: bunx tsc -p src/mastra clean; full `bun test` 243 pass / 22 skip / 0 fail (was 241; +2 credix
  tests). Not yet committed.

VERIFIED (user note 2 — do workers see prior turns?): YES, via Mastra's default full-context forwarding,
NOT via worker memory. docs-agents-supervisor-agents.md (core 1.45) "Memory isolation": subagents receive
the supervisor's full conversation context on delegation; only the delegation prompt+response save to the
worker's own memory (fresh thread per invocation). masterStep runs the master with
memory:{thread:session_id,resource:user_id}, so the real session history accumulates on the master and is
forwarded down. REAL LIMIT: the workflow's `messageFilter: messages.slice(-20)` caps forwarded context to
the last ~20 messages, so in long chats older turns fall out of the worker's view and "never re-ask" can
resurface. Tuning knob (raise the slice or summarize), not a bug.

## 2026-07-16: Live 6-turn single-session probe (feat/master-supervisor, Gemini) + delegated-name fix

Ran `bun run probe` (src/mastra/scripts/probe-turn.ts) against the REAL stack: Hono -> bureau sidecar
(:8000, live) -> masterAgent (gemini-3.1-pro-preview) -> workers (gemini-3.5-flash) + catalog DB tools.
One session, 6 turns, fresh session_id. All 6 turns 200, degraded=false, no errors. Total 218s (~28-50s/
turn; latency left as-is per prior user call). session 28e4c47c..., trace 112ae7dd4cabf82a073af8b5352392fd.

Tools confirmed firing live (via a TEMP masterStep diagnostic, since reverted): getSignals, getBureauDetail,
getCardCriteria, checkCardEligibility, getCardFullProfile, compareCards, getCardPartnerRates, exaSearch,
plus Mastra's updateWorkingMemory. Not exercised this session (not needed): getCardFees, getCardBenefits,
getCardDetails, getStatement.

Behaviour validated:
- Full-rundown word-cap exception WORKS end to end: turn 4 ("complete rundown of HDFC Infinia") called
  getCardFullProfile and returned ~165 words (annual fee ₹14,750 incl 18% GST, ₹10,00,000 waiver, 5 pts/₹150
  = 3.33% base, SmartBuy up to 33%, unlimited lounge). Confirms the master+worker 200-word exception both
  fire; a card-addendum-only change would have been recompressed to 120 by the master.
- "Never re-ask" memory carryover WORKS: turn 1 stated ₹80,000/mo spend + travel/dining + 6 flights/yr;
  turn 5 (compareCards Infinia vs Atlas) reused ₹80,000 without re-asking and computed ₹9,60,000/yr =
  "₹40,000 short" of the ₹10L waiver. Within the messageFilter slice(-20) window, as designed.
- Persona held: **756** bold, ₹ Indian grouping (₹34,569 / ₹25,00,000), digits, no dashes.
- Cross-domain delegation works: turn 1 delegated to BOTH credixAgent + creditCardAgent.

BUG FOUND + FIXED (credix-workflow.ts masterStep): the `delegated` filter matched bare keys
('creditCardAgent'/'credixAgent'), but Mastra names delegation tools `agent-<key>`
(agent-creditCardAgent / agent-credixAgent), so the `app.delegated_workers` Honeycomb attribute was
silently ALWAYS empty. Fixed to match the `agent-` prefix and record the stripped key. Pre-existing since
the master-worker cutover; not caused by the addenda change. tsc clean, workflow+agents tests 15 pass/0 fail.

OBSERVATION (not fixed): the creditCard worker called exaSearch on every card turn (3-6), despite the
addendum's "exaSearch only for a null field". Either genuine catalog nulls or over-eager verification; adds
latency. Candidate to tighten the addendum or log null-fields to see if justified. probe.local.json now holds
the 6-turn script (gitignored, real mobile preserved).

## 2026-07-16: Fix Honeycomb trace legibility, name + enrich LLM spans (tracing.ts)

Pulled the live trace (112ae7dd...) via the Honeycomb MCP. Diagnosis: the custom spans were fine
(stage.decode / pre-guardrail / agent.generate / post-guardrail / memory-writeback / om.writeback / compose,
plus catalog.* / signals.lookup / bureau.fetch / user-story.fetch), but EVERY outbound LLM + Exa call was
named just "POST" (auto @opentelemetry/instrumentation-undici). One turn's agent.generate held 7-17 identical
"POST" children (master + workers + working-memory) with no way to tell them apart, plus dns.lookup /
tcp.connect / tls.connect connection-setup noise at depth 4-5. Model/method/provider were present only as
url.full / user_agent attributes, not in the span NAME.

Fix (tracing.ts, verified against installed instrumentation-undici@0.29.0 RequestHookFunction = (span, req)):
- Added an undici `requestHook` that renames outbound calls by target and lifts attributes:
  - Google path /v1beta/models/<model>:<method> -> span name `llm <model>` + app.llm.provider=google,
    app.llm.model, app.llm.method (generateContent | streamGenerateContent).
  - api.exa.ai -> span name `exa.search` + app.http.api=exa.
  - Wrapped in try/catch so instrumentation can never break the request path.
- Disabled @opentelemetry/instrumentation-dns and -net to drop the dns/tcp/tls connection-setup noise.

Verified live (fresh 2-turn probe, trace 214ae4f5...): the card turn's agent.generate now reads
`llm gemini-3.1-pro-preview` (master, opening + 13.5s synthesis) around `llm gemini-3.5-flash` x several
(worker), `catalog.full_profile`->`catalog.details`, `exa.search` x3. No POST spans, no dns/tcp/tls spans.
Also confirms model attribution: master=gemini-3.1-pro-preview, workers=gemini-3.5-flash, keyed on GEMINI_API_KEY.
And confirms the delegated-name fix landed: app.delegated_workers=creditCardAgent now populates (was empty on
every span of the pre-fix trace). tsc clean.

Hardening (2026-07-16, follow-up): the requestHook now also falls back to `<METHOD> <host>` for any outbound
call that is neither Gemini nor Exa (e.g. ElevenLabs TTS on a tts turn), so nothing can render as a bare "POST"
again. tsc clean; verified on a fresh 1-turn probe (trace 435b6506...): 21 spans, all named, zero POST/dns/tcp/tls.
NOTE for future sessions: Honeycomb spans are immutable, so pre-fix traces (e.g. the 6-turn 112ae7dd...) keep
their POST/dns/tcp/tls names forever; only processes started AFTER the tracing.ts edit emit clean spans. A
long-running `dev` server must be restarted to pick up the change (--import ./tracing.ts re-reads on boot only).

OBSERVATION: in the 2-turn run the master answered turn 1 ("how can I improve my credit score") itself with
0 tool calls / 0 delegations (app.tool_calls.count=0), despite MASTER_ADDENDUM's "for anything factual,
delegate". Delegation is non-deterministic (the 6-turn run delegated every turn). If the master answering
factual turns directly becomes a problem, tighten the addendum ("delegate every factual turn, answer directly
ONLY for greetings/small talk"). Not fixed. All tracing/agent changes still uncommitted on feat/master-supervisor.

## 2026-07-16 fix: drop phantom GENERAL_INFO_SCORE_STG join from SQL_BY_MOBILE (L3 500)

SYMPTOM: bureau_internal.get_bureau_profile 500s on any L1/L2 miss; Snowflake
ProgrammingError 002003 (42S02) "Object 'GENERAL_INFO_SCORE_STG' does not exist or not
authorized" from snowflake_client.fetch_scrub_row (resolver.py:123 L3 read-through).

ROOT CAUSE: SQL_BY_MOBILE (src/nodes/raw_data/bureau/snowflake_client.py) LEFT JOINed a
staging table GENERAL_INFO_SCORE_STG (line ~148) and selected stg.SCORE AS SCORE_STG
(line ~136). That table is not present/authorized in the resolver's target db/schema, so
the whole query fails to compile. It is the ONLY query referencing it; SQL_BY_ID and
SQL_TOP join the same PII + 8 feature tables and are unaffected. The `_STG` (staging)
artifact was copied in from the app's pre-processing SQL (complete_by_mobile.sql, which no
longer exists in-repo). The SCORE_STG column it produced is DEAD: grep across the repo
shows nothing reads it. Downstream credit score comes from normalizer's `SCORE`
(mapped from GENERAL_INFO.SCORE); engine.py:294,369 read u.get("SCORE").

FIX: deleted the two lines referencing the phantom table (the SELECT of stg.SCORE and the
LEFT JOIN). SQL_BY_MOBILE core join now matches known-good SQL_BY_ID shape, plus its
legitimate mobile-keyed nohit/unscr blocks. Deletion-only, no new code.

VERIFY: static only here (no Snowflake creds in this session) — module ast-parses, and an
assertion confirms GENERAL_INFO_SCORE_STG/SCORE_STG are gone while all 8 feature tables +
NOHIT_DATA/UNSCRUBBED_DATA remain. Real proof pending: one live L3 fetch (force_refresh /
cold-cache mobile) should now return 200.

## 2026-07-29 — ZT-730 RequestContext + ZT-729 Langfuse tracing, split onto one PR branch

Context for a cold reader: work sat uncommitted in the tree for days (the 2026-07-16 note below
saying "still uncommitted on feat/master-supervisor" was stale; PR #18 has since merged into dev and
origin/dev tip 7b9471b matches what was on integration/dev-catalog-supervisor). Branched
`feat/langfuse-tracing-request-context` off that point and split the tree into two ticket-scoped
commits per Contribution/commit_template.md, plus a chore commit.

**ZT-730 (901c8e1) — user_id comes from a per-request context, not the model's echo.**
`server.ts` builds one `RequestContext` per `/v1/chat` carrying `user_id`, `channel` and
`MASTRA_RESOURCE_ID_KEY` (the last pins memory ownership to that user), and passes it into
`createRun().start()`. `credix-workflow.ts` masterStep now destructures `requestContext` and
forwards it to `masterAgent.generate`, so the workers it delegates to inherit it. `getSignals`,
`getStatement` and `getBureauDetail` resolve
`context?.requestContext?.get('user_id') ?? inputData.user_id`, i.e. context first with the arg as
fallback so direct tool calls outside a run still work. New regression test in
`signals-tool.test.ts` points the arg at an unknown user and the context at a known one, and asserts
the known user's signals come back. WHY: the previous design put `user_id` in the prompt and trusted
the LLM to repeat it in every tool call; a paraphrase or drop reads the wrong user. This reverses the
2026-07-13 decision in findings.md, which now carries a CORRECTED note.

**ZT-729 (fce7ad2) — Langfuse AI tracing, key-gated, PII scrubbed.**
New `lib/langfuse-observability.ts`: `buildObservability()` returns `undefined` unless both
`LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` are set, so unconfigured runs construct nothing and
export nothing. Two span output processors before export: Mastra's `SensitiveDataFilter` (redacts by
field NAME) and a local `identifierScrubProcessor` that deep-scrubs span input/output/metadata plus
the `prompt`/`instructions` attributes by VALUE, reusing `scrubIdentifiers` from `lib/otel` (the same
regex the OTel I/O capture uses) so mobile/PAN/Aadhaar embedded in free text cannot leak. `index.ts`
exports `observability` and spreads it into the Mastra instance only when configured; `server.ts`
flushes buffered spans on SIGTERM (wrapped in try/catch, exit still proceeds) so the last batch is
not lost on deploy. `.env.example` documents the three keys and says to point BASE_URL at a
SELF-HOSTED Langfuse. `.gitignore` pattern widened to `RightCard_Decode_N1_Eval*.xlsx`: it only
covered the unscored input, so the scored eval sheet was sitting untracked and one `git add -A` from
committing eval data.

**Chore commit:** AGENTS.md (Codex-native entry point pointing at SETUP.md), README pointer, the
no-AI-co-author rule in .claude/rules/git-practices.md + .claude/skills/commit/SKILL.md +
lessons.md, langgraph.json deletion, and the now-dead `dev-graph` Makefile target that ran
`langgraph dev` against the deleted config.

VERIFY: `bun run typecheck` clean, `bun test` 247 pass / 22 skip / 0 fail, on the full tree before
each commit. NOT verified live: no Langfuse keys and no bureau/model credentials in this session, so
no real trace was captured and no live `/v1/chat` turn was run. The Langfuse gate is therefore proven
only in its OFF state. Both live checks are logged as follow-ups in todo.md, along with
`getBureauProfile` (tools/bureau.ts:28) being the one `user_id` tool left un-converted and the
LangGraph pins still in pyproject.toml.

## 2026-07-30 — Provider switched back to xAI Grok; master/worker models are env-driven

WHY: user asked to move off Gemini back to Grok, and to have the model choice live in .env so a swap
never needs a code edit again.

Model inventory came from a live call to `GET https://api.x.ai/v1/language-models` with the .env
XAI_API_KEY. Six text models on that key, price per 1M tokens in/out: grok-4.20-0309-non-reasoning
1.25/2.50, grok-4.20-0309-reasoning 1.25/2.50, grok-4.20-multi-agent-0309 1.25/2.50, grok-4.3
1.25/2.50, grok-4.5 2.00/6.00, grok-build-0.1 (alias grok-code-fast-1) 1.00/2.00. All text+image in,
long-context pricing doubles past 200k prompt tokens. There is no cheap mini tier any more: grok-3
and grok-3-mini are gone from the key, so the old `LLM_MODEL=grok-4.3` / `UNDERSTAND_MODEL=grok-3`
pair could not have been restored as-is.

Probed each candidate through Mastra's model router with a forced tool call (temp script, deleted):
all five text ids resolve and tool-call. Round trip for "call the ping tool and report the number":
grok-4.20-0309-non-reasoning 1.4s, grok-4.5 2.8s, grok-4.20-0309-reasoning 3.6s, grok-4.3 5.9s,
grok-build-0.1 10.5s. grok-4.20-0309-reasoning also emitted a stray `\confidence{80}` token in its
reply, which is a real risk for a user-facing turn. grok-4.5 is NOT in @mastra/core 1.45's baked xai
model list but resolves anyway (the models.dev gateway is fetched at runtime), so a newer id being
absent from the registry is not a blocker.

User picked master grok-4.5 (it writes the user-facing synthesis) and worker
grok-4.20-0309-non-reasoning (fastest, cheapest, clean output).

- src/mastra/lib/provider.ts: MASTER_MODEL_ID = `xai/grok-4.5`, WORKER_MODEL_ID =
  `xai/grok-4.20-0309-non-reasoning`, both still `process.env.X ?? default`. Mastra reads XAI_API_KEY
  itself, so no shim is needed for xAI; the GEMINI_API_KEY -> GOOGLE_GENERATIVE_AI_API_KEY forward is
  kept so switching back to `google/*` is a pure .env edit.
- src/mastra/server.ts: the startup key warning was Gemini-only and would have fired on every boot;
  it now warns only if none of XAI_API_KEY / GEMINI_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY is set.
- src/mastra/memory/index.ts: comment no longer claims the OM Observer/Reflector is a Gemini model.
- .env: added MASTER_MODEL + WORKER_MODEL next to XAI_API_KEY. Removed the dead `GROK_API_KEY`,
  `LLM_MODEL=grok-4.3`, `UNDERSTAND_MODEL=grok-3` lines: their only reader was the deleted Python
  LangGraph path (src/nodes/llm/grok_client.py is superseded per plan/nodes-to-mastra-mapping.md).
  Node's --env-file strips the inline `#` comments on those two lines, verified.
- .env.example + README env table: xAI first, Gemini documented as the one-env-edit alternative, and
  the other usable Grok ids listed inline.

VERIFY: `npx tsc --noEmit` clean; `bun test` 247 pass / 22 skip / 0 fail (the offline suite sets a
fake GEMINI_API_KEY and never resolves a live model, so no test change was needed). Live: one real
`masterAgent.generate("Which credit card is good for airport lounge access?")` returned a
persona-compliant reply (digits, no dashes, under 120 words) after 2 delegations in 15.3s, so master
-> worker delegation works on the Grok pair. NOT verified: no full `/v1/chat` turn through the bureau
sidecar (probe.local.json needs a real mobile, which is PII and the user's to supply), so the
fetchBureau -> understand -> guardrail path is unproven on Grok, and no Gemini latency baseline was
captured for comparison.

## 2026-07-30 — Every turn is one Langfuse trace, session-grouped and user-attributed

WHY: user wants all conversations in Langfuse as general LLM observability. Explicitly NOT evaluators
for now (LLM-as-judge and dataset capture were both offered and declined), and explicitly the RAW
mobile as the Langfuse user id (an HMAC hash was offered and declined; the concern was stated and the
choice reaffirmed, so it is recorded here as a product decision, not an oversight).

State found: tracing was already live, contradicting the previous handoff note. 106 traces existed on
hipaa.cloud.langfuse.com, so the ZT-729 gate was never actually unproven in its ON state. But every
turn produced TWO unrelated traces ('credix-workflow' with 12 observations and 'Master' with 38),
neither carrying a user, and only the agent one carrying a session (incidentally, from the memory
threadId fallback in the exporter). The project has 0 evaluators, 0 evaluation rules, 0 LLM
connections; the `experiment-item-run` traces with 4 scores each came from an external runner against
the `n1-decode-eval` dataset, not from Langfuse-hosted eval.

Changes:
- workflows/credix-workflow.ts masterStep: destructure `tracingContext` from the step params and
  forward it into `masterAgent.generate`. Without it the agent starts its own root trace. This is what
  collapses a turn into ONE trace (43 observations: agent, generations, tool, delegation spans).
- server.ts /v1/chat: `run.start({ ..., tracingOptions: { metadata: { traceName, sessionId, userId,
  channel } } })`. The @mastra/langfuse exporter maps `sessionId` -> Langfuse session (turns of one
  conversation group), `userId` -> Langfuse user, `traceName` -> trace name. traceName is load-bearing:
  once the agent spans nest, the exporter's own root-span naming produced EMPTY trace names (verified
  live across 4 runs, in both batched and realtime mode), so the list view was blank rows. Other
  metadata keys (channel) are not promoted to trace level and stay on the root span.
- server.ts shutdown: the flush handler now covers SIGINT as well as SIGTERM. A turn's root span ends
  LAST, so an unflushed exit loses precisely the trace-level record (name, input, output, workflow
  metadata) while the child spans survive; that is exactly what the first probe runs showed, and it is
  how the empty-name symptom was first misdiagnosed. Ctrl+C in dev hits SIGINT.
- lib/langfuse-observability.ts: identifierScrubProcessor now exempts `metadata.userId` from the value
  scrub. Without the exemption the mobile regex rewrote it to `[REDACTED]`, collapsing every user into
  one bucket. Everything else in metadata, all span input/output, and the prompt/instructions
  attributes are still scrubbed.
- lib/langfuse-observability.ts: `buildObservability()` now requires LANGFUSE_BASE_URL alongside the
  two keys. The docstring already claimed a three-var gate (PR #19 review) but the code checked only
  the keys, and with an unset base URL the Langfuse SDK defaults to the PUBLIC cloud.langfuse.com.
  With a raw mobile now on every trace that gap was a direct PII leak. .env.example rewritten to say
  the destination holds PII and must be self-hosted or HIPAA-tier.

VERIFY: `npx tsc --noEmit` clean, `bun test` 247 pass / 22 skip / 0 fail. Live: 5 workflow turns via a
temp probe (deleted) using the SYNTHETIC user 9000000001 and a stub bureau_profile, so no real
subscriber data was involved. Final run, read back through langfuse-cli: trace name `credix-turn`,
sessionId `lf-probe-e`, userId `9000000001` (raw, unscrubbed as chosen), trace input and output
present, 43 observations, both generations with model + token counts, and `user_id` inside the trace
input payload showing as `[REDACTED]`. Two turns on one session id landed in the same Langfuse
session. NOT verified: no turn through the real /v1/chat route with a real mobile (needs
probe.local.json, which is the user's to supply), and `calculatedTotalCost` is 0 on every generation
because the Langfuse project has no pricing for the grok ids (logged as a follow-up).

**PR #19 co-review (125b203).** Copilot's one unresolved thread was on the Langfuse gate: both keys
set with LANGFUSE_BASE_URL unset lets the SDK fall back to the public cloud.langfuse.com, so a
deployment meaning to keep financial data in its own instance would have exported it to a shared
tenant silently. The base URL is now part of the gate (all three vars or tracing is off), keys with no
URL log a warning first so the state does not read as a broken integration, and
__tests__/observability-gate.test.ts pins all four combinations. This matters more since the trace
level user id became the raw mobile: an unnamed destination is a PII export, not a misfiled trace.
The docstring also stopped claiming "self hosted only", because the live instance is HIPAA tier cloud.
Replied on the thread with the SHA and resolved it; PR #19 is at 0 unresolved.

### Same day, verification on a real subscriber (user-supplied mobile)

Ran `bun run probe` with a real 10-digit mobile in `src/mastra/probe.local.json` (gitignored), two
turns on one session, channel web, through the real Hono `/v1/chat` -> bureau sidecar -> master ->
workers -> guardrail -> compose path. Both turns returned 200 with grounded, persona-compliant replies
built from real bureau data.

- One Langfuse SESSION (`ec0c4244-...`) holding both turns, each a single `credix-turn` trace with
  the raw mobile as the Langfuse user. Trace input/output populated on both.
- Turn 1: 43 observations, 18.9s. Turn 2: 84 observations, 28.2s, four generations (master grok-4.5
  16709/813 tokens; workers grok-4.20-0309-non-reasoning 10852/410, 38241/280, 16000/121).
- PII audit of the exported turn-2 trace JSON: the real mobile appears 86 times and EVERY occurrence is
  the deliberate `user.id` attribute (trace level plus its copy on each observation). Zero occurrences
  in prompts, messages, tool I/O, or the bureau payload; `user_id` inside the trace input reads
  `[REDACTED]`. No PAN and no Aadhaar anywhere. So the scrub exemption is scoped exactly as intended.
- Added the Langfuse flush to scripts/probe-turn.ts. It waited only for the OTel batch delay, which is
  a different pipeline, so probe runs would have lost each turn's trace-level record.

Two things this exposed, both logged as todo follow-ups:
- The trace INPUT carries the RAW bureau_profile (general_info, loan_details, enquiries,
  loan_repayments, dpd, institution_details) in plaintext. That predates today (it is the workflow root
  span's input), but it now sits next to an identified user, which is a different risk profile than
  when the user was anonymous.
- 38241 prompt tokens on one worker call, and 28.2s for turn 2, is the existing latency follow-up
  showing up with numbers attached.

## 2026-08-03 — PR #19 review round 2: user_id leaves the prompt and the tool schemas

WHY: Copilot and Codex both filed findings on the ZT-730 context-first change and on this session's
tracing work. Three were actioned; the raw-mobile-as-Langfuse-user-id pair was explicitly deferred by
the user ("can be ignored, will be taken care further"), so those threads got a reply and stay open.

- workflows/credix-workflow.ts: dropped the `[user_id for tool calls: ...]` line from the master
  prompt (Copilot, credix-workflow.ts:137). It was left over from the pre-ZT-730 design: the tools
  read the server-verified id from requestContext now, so the line only re-invited the LLM echo ZT-730
  removed and shipped a mobile number to xAI on every turn.
- lib/normalize-user-id.ts: new `resolveUserId(arg, context)`. Context wins, arg is a fallback for
  direct calls outside a run, and with neither present it THROWS rather than fetching for whoever the
  fallback happens to name.
- tools/signals.ts, tools/statement.ts, tools/bureau.ts (getBureauDetail): `user_id` is now
  `.optional()` with a description telling the model to leave it out, and each calls resolveUserId
  (Codex P2, signals.ts:28). This was a real hole, not a style nit: while the schema required the
  field, a worker that trusted the context and omitted it had its call rejected by input validation
  BEFORE execute ran, so the context-first lookup never happened and the exact case ZT-730 aimed at
  stayed broken. getBureauProfile is deliberately untouched; it is still unreferenced by agents and
  carries its own delete-or-convert todo.
- __tests__/signals-tool.test.ts: two cases added for the gap the old test missed. It only covered a
  WRONG supplied arg; now there is one for the arg omitted entirely (schema parse plus context
  resolution) and one asserting the throw when neither source has an id.

VERIFY: `npx tsc --noEmit` clean, `bun test` 253 pass / 22 skip / 0 fail. Live, three turns on one
session through the real /v1/chat with TEST_MOBILE (sidecar had to be restarted; it and the dev server
had died, which is what the first 502 run was): all 200. Langfuse shows 3 `credix-turn` traces on
session d43d315f, and the decisive evidence for both fixes is that turn 1 called
`agent-credixAgent` -> `getSignals` successfully with ZERO occurrences of `user_id unavailable` and
ZERO occurrences of `user_id for tool calls` anywhere in the exported traces. Zero ERROR observations
across the three turns. Turns 2 and 3 exercised getCardFullProfile / getCardPartnerRates.

Also in this batch: scripts/probe-turn.ts defaults the mobile to TEST_MOBILE from .env (the number
lived in two places), and flushes Langfuse before exit, which the OTel-only wait did not cover.

### 2026-08-03 — Copilot's third pass: financial payloads out of traces, email added to the scrub

Copilot re-reviewed 6 minutes after the fc8b370 push and filed two new threads, both landing on the
same thing I had already logged after the real-mobile test: trace input carried the raw bureau payload,
and scrubIdentifiers only knows mobile/PAN/Aadhaar.

Fixed in 1c806be, both threads replied to and resolved:
- lib/langfuse-observability.ts: OMITTED_KEYS (bureau_profile, masked_profile, signals) dropped
  RECURSIVELY from span input and output. Recursion matters: measured against a real trace, the payload
  rode nested inside step spans (33 hits) and the memory processors (Observational Memory 134, Working
  Memory 40), so the first top-level-only version I wrote missed most copies. Dropped by key rather
  than scrubbed because bulk financial data has no identifier pattern to match.
- lib/patterns.ts + lib/otel.ts: EMAIL_PATTERN, applied BEFORE the digit patterns so an address with a
  10-digit local part is not left as [REDACTED]@domain. Shared helper, so the Honeycomb capture and the
  Exa outbound path get it too.
- Tests: nested + top-level omission, the userId carve-out, and email scrubbing incl. the mobile-as-
  local-part case. 257 pass / 22 skip / 0 fail, tsc clean.

VERIFIED LIVE on a real bureau-backed turn, trace read back through the API: trace input shows
"[omitted: financial payload, not exported]", 18 omitted markers in the span tree, 0 emails, 0
AGE_EXACT/income keys, mobile only as the deliberate user id.

RESIDUAL, and a CORRECTION to an earlier claim in this file: ~376 financial key-name hits remain inside
PROMPT TEXT, because masterStep embeds the masked profile as a JSON string and key omission cannot
reach into a string. Also, the earlier assertion that the 38k-token prompts were the raw bureau profile
(and therefore that the PII fix would also fix latency) did NOT survive checking: exported generation
input was ~12.5k chars against 33.8k reported tokens, so composition cannot be attributed from the
export. The two problems are independent. Both are written up in the new tasks/improvements.txt.

Also created tasks/improvements.txt: a ranked ledger of the 9 open items (prompt-text residual,
latency, missing Langfuse cost pricing, the deferred raw-mobile decision, tool-reached bureau data,
model choice resting on a synthetic benchmark, comment density, PR scope, and the carried todo.md
smalls), each marked with what is measured versus assumed.

### 2026-08-03 (later) — PR #19 review threads closed out, 0 unresolved

Posted a closing comment on the two raw-mobile threads (server.ts:192, langfuse-observability.ts:58)
and resolved them. They are closed as ACCEPTED DECISION, not as fixed: the code still exports the raw
mobile and still exempts that one field from the value scrub. Each comment opens by saying so, because
a resolved thread that quietly still holds the issue is worse than an open one.

What the comments record: the decision and that hashing/omitting were offered and declined; the four
changes that narrowed the blast radius since the threads were filed (base-URL gate 125b203, prompt
identifier removed fc8b370, bureau/signals payloads dropped and emails scrubbed 1c806be); and the
verified end state, where the mobile is the ONLY PII left in a trace.

PR #19 is now 8 of 8 threads resolved. SIDE EFFECT worth naming: the PR no longer reminds anyone about
the raw mobile, so tasks/improvements.txt item 4 is the sole tracker. Corrected both improvements.txt
item 4 and the todo.md entry, which each still claimed the threads were deliberately left open.

## 2026-08-04 — Right-card flow port: Phases 0, 1, 8 shipped on feat/right-card-flow

Branch stacked on feat/langfuse-tracing-request-context (PR #19), since masterStep and the workflow are
touched by both. Plan: tasks/plan/plan-right-card-flow.md.

PHASE 0, the persona battery (commit 4879a3e). scripts/battery.ts + battery-cases.ts run 21 single-turn
and 8 multi-turn cases across 5 personas (expert, newbie, lowaware, adversary, hinglish) through the real
/v1/chat, log each turn to a gitignored scratchpad jsonl, and apply 10 regex checks. Ported working
practice from right-card. `bun run battery` (add --suite=single --limit=N for a smoke run).

BASELINE RESULT (scratchpad/battery-base0804.jsonl, graded into tasks/fix-queue.md D1-D9): 45 turns,
18.0 min, all HTTP 200, zero degraded, zero PII. Latency p50 21.8s, p90 37.5s, MAX 89.1s. The important
finding: the master's narrate-then-glue defect is ENDEMIC at 16 of 45 turns (36%), not the one-off it
looked like on 2026-08-03; right-card hit the identical wall (their M2) and concluded it needs a general
rule for all agents rather than a patch. A CRITICAL wrong answer also reproduced right-card's F1 exactly:
"first year cost of HDFC Infinia" came back ₹29,500 by summing joining AND annual.

Two of my own predictions were wrong and are corrected in the queue: compound asks are OVER-SERVED (69.5s,
over the word cap, both parts answered) rather than dropped; and the model already mirrors Hinglish
sometimes (H1 did, H2 did not, S4.1 did both in one reply), so the real defect is inconsistency, not
absence. The regex checks also missed the CRITICAL fee bug entirely, because it is semantic; the ported
per-case `watch` note is what made a human look. Both facts are recorded in the queue's blind-spot section.

PHASE 1, language (commit 1468900). lib/language.ts: detectLanguage (pure, script ranges plus a Hinglish
keyword list with a 2-marker threshold), LANGUAGE_NOTES, withLanguageNote, and nextLangState with
right-card's symmetric 2-vote debounce seeded from the first turn. lib/session-state.ts: bounded
in-process maps with capMapSize, documented as single-instance-only with Redis as the upgrade path.
server.ts detects per turn, commits per session, sets requestContext.language, and records detected vs
committed on the HTTP span. All three agents switched to function-valued instructions so the master AND
the delegated workers carry the note (right-card's finding 3d was that only their primary agent read it).
Two unit tests exist because the first implementation failed them: "the" was in the Hinglish marker list
and flipped "the card and the fee" to Hinglish; "rupees" and "mil" went for the same reason.
KNOWN LIMIT, in the code comment: a voice turn's transcript only exists after decodeStep, so an
audio-first non-English turn commits its language one turn late.

PHASE 8, skills (commit 4879a3e). Ported handoff (session-persistence.md already instructed us to "run
handoff skill", which did not exist here) and grill-me. fix-queue.md adopted as a standing convention in
the rules. Skipped: the mastra skill (the Mastra MCP server covers it) and the frontend-only ones.

VERIFY: tsc clean, bun test 277 pass / 22 skip / 0 fail. One caveat: a mid-work run showed 2 failures in
the card-catalog DB tests while the battery was concurrently holding the same pool; they pass on a clean
run, so do not chase them if seen alongside a battery.

NEXT SESSION STARTS HERE: Phase 2 (sticky/lastQuestion maps on the session-state module already created,
plus postGuardrailStep recording whether the reply ends in a question), then Phase 3 (classifyStep, regex
only, fast path behind a confident single-domain match). Open decision D1 in the plan is unanswered: start
the fast path with credit_card alone, or all confident single-domain intents. Recommend credit_card alone,
measured against battery-base0804 before widening. Also owed: an after-battery to confirm D6 is fixed.

### 2026-08-04 (later) — Phase A of the prompt incorporation, measured end to end

Plan: tasks/plan/plan-prompt-incorporation.md. Five commits, then a 45-turn after-battery, then two
follow-up fixes the diff exposed.

The step that mattered most was Step 0, before any prompt edit: lib/signal-summary.ts was injecting
"segment prime" and "thick file" INTO the master prompt, so 15 of the 18 internal-vocab flags were the
model echoing our own input. That turned D5 from a prompt-rule task into a one-line code relabel. Lesson
generalised in the plan: for each defect, ask first whether we are feeding it.

Results, same 45 cases before and after: internal-vocab 18->5, glued-text 16->5, announce-tool 10->2,
over-length 6->3, repeat-sentence 2->0, dash 1->0, clean p50 21.8s->16.6s. The CRITICAL D1 wrong answer
is fixed and verified: "first year cost of HDFC Infinia" now returns ₹14,750 with the joining-vs-annual
distinction stated, because getCardFees ships first_year_note WITH the numbers instead of leaving the
arithmetic to the model (right-card's 7d6cb0c lesson).

no-question REGRESSED 10->15, and that was the most useful result of the run. A7 (closing-question rule)
was deliberately held out of the round so its effect would be attributable; the regression shows A2/A3
made the master terse enough to drop the closing question too. A7 then landed as a measured fix, along
with A1b, which closed the two residual vocabulary leaks: getSignals was a SECOND mouth feeding "thick
file" from the raw payload (now relabelled via plainSignals at the tool boundary), and "income floor" was
sitting in our own addendum text.

Honest caveat recorded in tasks/fix-queue.md: the after-run had 6 upstream retry events which pushed 5
turns past 60s (max 324s), so its p90/max are throttling artefacts, not a regression. Only the clean p50
and the flag counts are comparable.

NEXT SESSION STARTS HERE: run `bun run battery` once (27 min, expect throttling if run back to back with
another) to measure A1b and A7, then grade into tasks/fix-queue.md. After that, Phase 2 and Phase 3 of
tasks/plan/plan-right-card-flow.md, where open decision D1 is still unanswered: start the fast path with
credit_card alone or all confident single-domain intents. Recommend credit_card alone.

## 2026-08-05 — PR #20 review round: Copilot threads resolved (commit e17bb3f)

Pulled the review on PR #20: 5 inline comments, 0 human. Codex 2 (P1, P2), Copilot 3. Ran the co-review
skill over the Copilot three; the two Codex threads are still OPEN and listed at the bottom of this entry.

Also ran a ponytail-audit over the PR's 18 changed files. Full ranked list is in tasks/improvements.txt
item 5; three of its findings overlapped the Copilot threads and shipped in this commit.

What shipped in e17bb3f, with the reasoning a cold reader needs:

1. src/mastra/lib/session-state.ts — capMapSize and the bare Map are DELETED. sessionLanguage is now
   backed by the repo's existing lib/ttl-cache.ts. Copilot was right that the old code was not the LRU
   its own comment claimed: Map#set on an existing key updates the value but does NOT move the key in
   insertion order, so a session on its 40th turn was as evictable as one abandoned after turn 1.
   ttlCache deletes EXPIRED entries before falling back to oldest-inserted, and server.ts re-sets the key
   every turn, so activity is what keeps an entry alive. SESSION_STATE_TTL_MS defaults to 6h,
   SESSION_STATE_MAX to 5000. Residual bound documented IN the file: 5000 simultaneously-active sessions
   still degrade to oldest-inserted, same bound the bureau cache accepts, failure is one reply in the
   previously committed language. This is also the ponytail finding: two bounded-map implementations in
   one repo where the older one already worked.

2. src/mastra/tools/card-catalog.ts — first_year_note is now purely USER-FACING. The "Do NOT add the two
   together for year one" imperative is gone from the string, because that string is quoted to the user
   (the addendum tells the agent to "quote those"), so an instruction aimed at the model was one prompt
   away from being read out loud. The rule survives in CREDIT_CARD_ADDENDUM (agents/credit-card.ts:39),
   which is where a model-facing instruction belongs. Note now carries the ₹ sign and Indian grouping per
   the persona rule; it emitted a bare "14750" before.

3. src/mastra/tools/card-catalog.ts — jfGst/afGst computed once and reused. Math.round(jf * (1 + GST))
   appeared 5 times in that block. first_year_total_with_gst is now `jfGst ?? afGst`, which is exactly
   what its ternary chain always computed. The nested ternaries became firstYearNote() with flat early
   returns, which is what made it unit testable.

4. src/mastra/tools/card-catalog.ts — ONE module level inr() replaces three near-duplicate money
   formatters (mapPartnerRow's `rupees`, the fuel-waiver local `inr`, and an inline template in the
   lounge formatter), two of which rounded differently. Fixing that also cleared an en dash in the fuel
   waiver range, which the persona bans and the battery's own `dash` check flags; it reads "to" now.

5. src/mastra/__tests__/partner-math.test.ts — 4 new cases on firstYearNote: Infinia's shape returns
   ₹14,750 and never 29,500; EVERY branch asserted to contain a ₹ and to contain no "do not"/"never", so
   a model-facing imperative cannot creep back into a user-facing string; joining-only and annual-only
   sentences; neither-published returns null rather than a fabricated zero.

6. src/mastra/tools/signals.ts — comment typo, "plainened" to "made plain". Function name plainSignals
   kept, it reads fine and signal-summary.test.ts asserts on it by name.

Verified: ./node_modules/.bin/tsc --noEmit clean. bun test 313 pass, 22 skip, 0 fail, 674 assertions,
335 tests across 28 files (was 298/320 at PR open; the delta is the partner-math work plus these 4).

All 3 Copilot threads replied to with the point-by-point fix and marked resolved; status endpoint
reports {"total":3,"unresolved":0}.

STILL OPEN, the 2 Codex threads, NOT touched in this commit and deliberately so (different reviewer,
different threads, user asked for co-review only):
- P1 scripts/battery.ts:194 — the jsonl row keeps the raw `reply` and raw `flags[].evidence`, so if the
  model ever does emit a PAN/Aadhaar/mobile, the battery persists it in plaintext. gitignored is not the
  same as scrubbed. Fix is rung 2: lib/otel.ts:59 already exports scrubIdentifiers, apply it at the
  append site and stop retaining raw evidence for the pii check specifically.
- P2 server.ts:173 — sessionLanguage is keyed by the client-controlled session_id alone, so two mobiles
  sharing a session_id read each other's committed language. Workflow memory already scopes the same
  thread id by user_id as its resource. Fix is one line, `${user_id}:${session_id}`, on the line the
  ttlCache change already touched.

## 2026-08-05 — PR #20 round 2: battery PII scrub and per-user language key (commit d030609)

A second review pass landed after e17bb3f. Copilot raised the battery log PII issue that Codex had
already filed as P1, so two reviewers independently converged on it; that plus Codex P2 closed the last
two open threads. All 6 threads on PR #20 are now replied to and resolved, unresolved=0.

1. src/mastra/scripts/battery.ts — every row is run through scrubIdentifiers (lib/otel.ts:59, the same
   helper the telemetry path uses) before appendFileSync. The premise of the `pii` check is that a reply
   CAN contain a PAN, so `reply` and that check's own `evidence` were the two fields guaranteed to hold a
   real identifier the day it fires, and both were being written in plaintext. `message` is scrubbed too.
   The flag `id` survives so the tally and grading are unaffected. scratchpad/ is gitignored, which is
   NOT scrubbed, and a backup or synced folder carries it regardless.

   ORDERING IS THE LOAD-BEARING PART, do not "simplify" this later: scrubbing happens at the DISK
   boundary, never before the checks run. A check must see the real identifier to flag it, so scrubbing
   earlier would silently turn `pii` into a check that can never fire; and repeat-reply compares against
   replies held in memory, which must stay like for like. scrubRow returns a NEW row rather than
   mutating, so the in-memory copy stays raw. CIBIL scores survive because lib/otel.ts deliberately does
   not scrub 3-digit values, which is what keeps a graded log usable at all.

2. src/mastra/scripts/battery.ts — main() is guarded on argv and the TEST_MOBILE validation moved inside
   it. Before, module scope called process.exit(1), so the file could not be imported by anything, which
   is precisely why scrubRow had no test. Guarded on
   `fileURLToPath(import.meta.url) === resolve(process.argv[1])` and NOT on import.meta.main: that needs
   Node >= 24.2, this repo pins no version anywhere (no engines field, no CI workflow, no Dockerfile),
   and where the property is missing `if (import.meta.main)` is silently false, so the battery would
   appear to run and do nothing. Caught by testing the real runner: `bun run battery` executes NODE plus
   tsx, not bun. Verified afterwards under both `npm run battery` and `bun scripts/battery.ts` (both
   reach main and hit the TEST_MOBILE guard) and that importing the file starts nothing.

3. src/mastra/server.ts:171 — language state keyed `${user_id}:${session_id}`. session_id is client
   supplied and not unique across users, so the second user read the first user's committed language, and
   the 2-vote debounce made it stick: their first English turn still answered in Hindi because one
   opposing turn is only a pending vote. Workflow memory already scopes its thread id by user_id as the
   resource, so this now matches that precedent. Phase 4's sticky-routing map must use the same key.

4. src/mastra/__tests__/battery-scrub.test.ts — 5 new cases: PAN in a reply redacted; the pii check's own
   evidence redacted while its id survives; the user message scrubbed; scores, percentages, ₹ amounts and
   latencies all intact; and scrubRow asserted not to mutate its input, since that would blind
   repeat-reply. No test for the composite key: it is a string change over nextLangState, whose debounce
   already has 14 cases in language.test.ts, and proving cross-user isolation would mean standing up the
   Hono app to watch a Map lookup miss.

Verified: ./node_modules/.bin/tsc --noEmit clean. bun test 318 pass, 22 skip, 0 fail, 690 assertions,
340 tests across 29 files (313/335 before this commit).

## 2026-08-05 — PR #20 round 3: the 7 suppressed comments, and a root-cause miss (commit 5c85cbd)

Copilot's review of d030609 reported "generated no new comments" at the top and then carried SEVEN
suppressed comments in a collapsed <details> block. Read that block: `unresolved=0` on the thread API does
not mean the reviewer found nothing. Fetch it with:
  gh api repos/financebuddha/credix/pulls/20/reviews --jq '.[]|select(.user.login|test("copilot"))|.body'

The important part is a mistake worth not repeating. Two of the seven were the SAME defect fixed in
e17bb3f (a directive to the model sitting inside a tool-output string the agent is told to quote), at
sibling call sites in the same file. e17bb3f fixed the line the review named, first_year_note, rather than
grepping the class, so math_note and no_data_note stayed broken. The ponytail rule covers this exactly:
a report names a symptom, and the fix belongs where all the sites are, not where the ticket points.

1. src/mastra/tools/card-catalog.ts — math_note's category_rate branch said "...not a deal negotiated with
   this merchant, so say it that way." and no_data_note said "...Do NOT state an earn rate, cap or value
   for this pairing; say it is not published and offer to check a card that does have one." Both are quoted
   to the user. Both are now purely factual statements.
2. src/mastra/agents/credit-card.ts — the behaviour no_data_note carried (say nothing is published, offer a
   card that does have a rate) moved into CREDIT_CARD_ADDENDUM, which already held the zero-rows rule, so
   the behaviour survives in the place an instruction belongs.
3. src/mastra/__tests__/partner-math.test.ts — MODEL_DIRECTIVE regex asserted against firstYearNote and
   against every branch of math_note, so the CLASS is pinned. NOTE for whoever tightens this later: it
   matches speech verbs (do not state/add/say/mention/quote/present/write/report, "so say it that way")
   and NOT a bare /do not/, because math_note legitimately says "Transactions under ₹249 do not qualify",
   which is a fact about transactions. That legitimate case is asserted in the same test, so the guard
   cannot be tightened into a false positive without failing.
4. src/mastra/lib/signal-summary.ts — buildSignalSummary calls plainSignals once and reads the plain
   fields, instead of re-implementing the same relabel inline directly beneath a comment claiming one
   source of truth. Was item 2 of the ponytail audit (tasks/improvements.txt item 10).
5. src/mastra/lib/language.ts — the Hinglish marker regex is compiled once at module scope instead of
   `new RegExp(HINGLISH_RE.source, 'gi')` on every request. It carries the /g/ flag, which is only safe
   because String.match resets lastIndex; .test() and .exec() do NOT, and would alternate answers on
   identical input. language.test.ts now calls detectLanguage 5 times on the same strings to pin that.
6. src/mastra/scripts/battery.ts — CheckCtx.message was threaded to all 10 checks and read by none. Gone.
   Was item 6 of the ponytail audit.

Verified: ./node_modules/.bin/tsc --noEmit clean. bun test 320 pass, 22 skip, 0 fail, 703 assertions,
342 tests across 29 files.

Thread state: 6 of 6 review threads on PR #20 resolved, unresolved=0. The 7 suppressed comments were not
threads, so there is nothing to reply to or resolve for them; they are closed by this commit instead.
Remaining ponytail-audit items after this: 7 of the original 9 (tasks/improvements.txt item 10).

## 2026-08-05 — PR #20 round 4: card-only mode was inventing per-merchant maths (commit 6fc630c)

Third suppressed block, 3 comments, and one is a real money bug rather than hygiene. Same pattern as round
3: thread API said unresolved=0, the finding was in the collapsed <details> of the review body.

1. THE BUG. src/mastra/tools/card-catalog.ts, getCardPartnerRates card-only mode passed monthly_spend into
   mapPartnerRow for EVERY partner row. monthly_spend means spend at one named merchant, and card_all
   returns every partner on the card up to LIMIT 50, so a user saying "I spend 15,000 a month at Swiggy"
   got a full computed earn plus math_note for Amazon, IRCTC, BookMyShow and every other partner, each one
   a confident money figure derived from a number that had nothing to do with it. Exactly the defect class
   this PR exists to close, in code we added ourselves. Fixed by not passing it in that mode; the schema
   description now says the field only applies when partner is set. card_partner and partner_all both have
   a single merchant fixed, so their arithmetic is meaningful and is unchanged.
2. src/mastra/__tests__/card-catalog.test.ts: 2 cases through the existing stubbed pool. Card-only with
   monthly_spend asserts computed is null on every row while reward_rate still comes through, so the facts
   survive and only the arithmetic is withheld; card+partner with the same spend still computes 750. The
   first case would have failed before this commit, which is what makes it a regression test rather than a
   restatement.
3. src/mastra/lib/session-state.ts: the doc comment still read "session_id -> committed/pending language"
   after d030609 made the key composite. Now states the composite key AND that any state map added here
   must use the same one, Phase 4's sticky routing specifically. A stale comment there would have handed
   the next author the exact isolation bug we had just fixed.
4. src/mastra/scripts/battery-cases.ts: 3 stale grader baselines where the review named 1. H1 said "today
   nothing handles Hinglish; expect an English reply. Phase 1 target.", the persona header said "nothing
   handles it today", and S7 said compound asks were unhandled so "expect one dropped". All three shipped
   in this PR. These watch strings are what a human grades the jsonl against, so a stale one gets a working
   fix recorded as a defect in fix-queue.md. Checked the rest: S3's sticky-routing note is still accurate,
   because Phase 4 has not shipped.

Verified: ./node_modules/.bin/tsc --noEmit clean. bun test 322 pass, 22 skip, 0 fail, 710 assertions,
344 tests across 29 files.

Running total for the review, 4 rounds: 6 threads (all resolved) plus 13 suppressed comments across 3
blocks. Of the 13, one was a money bug, two were directive leaks of the class first_year_note started, and
three were stale docs that would have misled a grader or the next author.

## 2026-08-05 — PR #20 round 5: flag and note disagreed; plus a test-run gotcha (commit d33dcf7)

Fourth suppressed block, 2 comments. Copilot reviewed HEAD (5274673) and skipped 6fc630c entirely, so a
poll keyed to a specific SHA misses it; poll for any bot review NEWER than the last one instead.

1. src/mastra/tools/card-catalog.ts — is_upper_bound fired on earn_quantum_amount alone, while the
   math_note sentence explaining it required BOTH earn_quantum_points and earn_quantum_amount. So a row
   with a block size but no points count was demoted below dependable rows by rankByValue and its note said
   nothing about why: a ranking penalty with no visible reason. One predicate, perBlockEarn, now drives
   both. DECISION worth keeping: it still fires on the amount alone rather than requiring both halves,
   because a block size means the real earn rounds DOWN, so dropping the flag would make the row look more
   dependable than it is. The note degrades instead ("Points accrue per ₹150 block, rounded down...")
   rather than inventing a points figure.
2. src/mastra/__tests__/partner-math.test.ts — amount-only case asserts the flag is set, the note explains
   the rounding, and the absent points count does not print as the string "null". The both-halves case now
   also pins the "1 per ₹100" wording.
3. src/mastra/scripts/battery.ts — mkdirSync moved from module scope into main(). battery-scrub.test.ts
   imports this file now, and importing a module should not create directories.

TEST-RUN GOTCHA, worth knowing before someone panics at a red suite. Run `bun test` from src/mastra, which
is where package.json and tsconfig live. Run it from the REPO ROOT and bun loads the root .env, which sets
TEST_AUDIO_URL=/home/beast/Downloads/test.mp3 and un-gates two opt-in STT integration tests in
__tests__/integration.test.ts. That file does not exist on this machine, so both fail with ENOENT and the
suite reads 326 pass / 2 fail / 17 skip instead of 323 / 0 / 22. Pre-existing and unrelated: this branch
touches neither decode.ts, integration.test.ts nor the STT path, and `git diff origin/dev...HEAD` over those
files is empty. Separately, TEST_AUDIO_URL in .env points at a file that is not present, so those two tests
cannot pass locally as configured; either drop the var or point it at a real sample.

Verified: ./node_modules/.bin/tsc --noEmit clean. bun test 323 pass, 22 skip, 0 fail, 715 assertions,
345 tests across 29 files, from src/mastra.

Running total, 5 rounds: 6 threads (all resolved) plus 15 suppressed comments across 4 blocks.

## 2026-08-05 — PR #20 round 6: an everyday offer was being ranked as conditional (commit 4a765e6)

Fifth suppressed block, 1 comment, same family as round 5: a truthy value standing in for "no restriction".

src/mastra/tools/card-catalog.ts, dayLabel returned the STRING "every day" when applicable_days held 7
entries. Truthy, so mapPartnerRow set is_upper_bound, rankByValue pushed the row below genuinely dependable
ones, and math_note appended "treat this as a ceiling, not a monthly expectation" to an offer that runs
daily. Net effect: a card whose row enumerates all 7 days ranked WORSE than an identical card that left the
column null, and the user was told to discount a rate that needed no discounting. Returns null now.

Two further corrections in the same function, only one of which the review named:
- Deduped before the length check. [3,3,3,3,3,3,3] is seven entries and ONE day, and the old
  `names.length === 7` called that a full week, so a Wednesday-only offer would have been presented as
  unrestricted. That is the same overstatement bug in the opposite direction, and worse.
- Out-of-range codes still surface as "day N" rather than being filtered out. Deliberate: an unrecognised
  value may be a real restriction, and dropping it reads as "no restriction", which overstates the offer.
  Overstating is the direction that costs a user money, so unknown data stays visible.
- `||` rather than `??` on the name lookup, since DAY_NAMES[0] is an empty-string placeholder and rendered
  as " only".

src/mastra/__tests__/partner-math.test.ts, 3 cases: all 7 days gives a null label, is_upper_bound false, no
ceiling wording, and the SAME annual_value and flag as a row with no day column at all (that last pair is
what pins the ranking parity, which is the actual defect); 7 duplicates of one day still reads "Wednesday
only" and stays conditional; an unknown code surfaces as "day 9 only".

Verified: ./node_modules/.bin/tsc --noEmit clean. bun test 326 pass, 22 skip, 0 fail, 724 assertions,
348 tests across 29 files, from src/mastra.

Running total, 6 rounds: 6 threads (all resolved) plus 16 suppressed comments across 5 blocks. Pattern worth
naming for the next session: rounds 4, 5 and 6 were all the SAME shape, a value that means "no constraint"
being encoded as something truthy (monthly_spend applied where it did not apply, is_upper_bound firing
without its note, "every day" as a restriction label). Anywhere else this code turns an absent constraint
into a present-but-empty one is worth a look before the next battery run.

## 2026-08-05 — PR #20 round 7: the miles note contradicted its own numbers (commit 6baf51f)

Sixth suppressed block, 1 comment. Reviewed commit was 016c463, which predates the dayLabel fix, so this
finding was independent of round 6 rather than a repeat of it.

src/mastra/tools/card-catalog.ts, math_note printed "At ₹15,000 a month, 5% earns ₹750 a month and ₹9,000 a
year." and then appended "Paid in EDGE points, not rupees, so the rupee value depends on redemption." Two
problems in one sentence: it contradicts the ₹ figures in the same note, and it contradicts the tool's own
documented contract, since getCardDetails (card-catalog.ts:1232) states reward_rate is value-back per rupee,
e.g. 0.01 = 1%. So those ₹ figures ARE the rupee estimate and the note was denying them.

Reworded as an estimate rather than a denial: "This earns EDGE points rather than cashback, so treat the
rupee figures above as an estimate that depends on how you redeem." is_upper_bound already covered this case
and is unchanged, which is correct, the figure genuinely is a ceiling.

src/mastra/__tests__/partner-math.test.ts, the existing program-currency case now also asserts the note does
NOT contain "not rupees", DOES contain "estimate", and still carries a ₹ figure. That last one matters: the
fix must FRAME the rupee estimate, not withhold it, and a future edit that deletes the number to resolve the
contradiction would pass a naive assertion.

Verified: ./node_modules/.bin/tsc --noEmit clean. bun test 326 pass, 22 skip, 0 fail, 727 assertions,
348 tests across 29 files, from src/mastra.

Running total, 7 rounds: 6 threads (all resolved) plus 17 suppressed comments across 6 blocks. Every round so
far has produced at least one finding, and rounds 3 through 7 came ONLY from the suppressed block while the
thread API read unresolved=0.

## 2026-08-05 — PR #20 round 8: 7% printed as 7.00% (commit d6c8131)

Seventh suppressed block, 3 comments. One is user-visible, and the review's justification for it was wrong
while its conclusion was right, which is worth recording as a reason to verify a reviewer's example.

1. src/mastra/tools/card-catalog.ts, math_note chose decimal places with `rate * 100 % 1 === 0`. Copilot
   said 0.3 * 100 becomes 29.999..., which is FALSE, that one is exact in JS. Checked all 100 two-decimal
   rates: 8 of them fail the test, and the failures include entirely plausible reward rates.
     0.07 -> 7.000000000000001    printed "7.00%"
     0.14 -> 14.000000000000002   printed "14.00%"
     0.28 -> 28.000000000000004   printed "28.00%"
     0.29 -> 28.999999999999996   printed "29.00%"
     also 0.55, 0.56, 0.57, 0.58
   Fixed with Number((rate * 100).toFixed(2)), which is the idiom ALREADY used for the fuel waiver pct
   further down the same file, so this is reuse rather than a new approach. toFixed rounds, Number drops the
   trailing zeros, so a whole percent reads "7%" and a real fraction still reads "2.5%".
2. src/mastra/tools/card-catalog.ts, monthly_spend rounded to whole rupees ONCE at the top of the computed
   block, with every downstream use reading the rounded value (earningSpend, bindingCap, headroom,
   computed.monthly_spend and the note). The schema accepts any positive number while inr() and the fields
   all round, so 15000.6 left computed.monthly_spend at 15000.6 while math_note printed ₹15,001. Chose
   rounding over .int() on the schema: rejecting the call would turn a model passing a decimal into a failed
   tool call and a retry, where rounding just answers.
3. src/mastra/scripts/battery.ts, the pii check now uses PAN_PATTERN, AADHAAR_PATTERN and MOBILE_PATTERN
   directly instead of `new RegExp(PATTERN.source)` per reply. Verified they all carry /g/ and that [0] is
   the first match either way, so the evidence string is unchanged. Net 4 lines deleted.
4. src/mastra/__tests__/partner-math.test.ts, 2 cases: the three float-unsafe rates print without decimals
   while 0.025 still reads 2.5%; a 15000.6 spend yields monthly_spend 15001 with matching prose.

Verified: ./node_modules/.bin/tsc --noEmit clean. bun test 328 pass, 22 skip, 0 fail, 734 assertions,
350 tests across 29 files, from src/mastra.

Running total, 8 rounds: 6 threads (all resolved) plus 20 suppressed comments across 7 blocks. One review
pass, on 72baf60, came back fully clean with no suppressed block at all, which is the only clean pass so far.

## 2026-08-05 — Tool-fetch coverage battery, 100 direct cases + Langfuse evals, and two HIGH bugs

User asked for 100 end-to-end tool-call tests proving the tools can actually FETCH, with the results visible
in Langfuse as evals, and for all user memory to be cleared first. Both depths were chosen (direct matrix
plus an agent pass) and the wipe was scoped to the live DB's memory tables.

MEMORY WIPE. src/mastra/mastra.db is the live store (`file:./mastra.db` is CWD-relative, so the 1.2 MB
./mastra.db at the repo root is a stray from running there once; left alone by user choice). Before: 6
resources, 211 threads, 907 messages, 637 observational-memory rows, 8 distinct users. All four tables are
now 0; schema and the other 33 tables untouched. Backed up first to
scratchpad/mastra.db.backup-222659 (21 MB). Also noticed while counting: one mastra_resources id began
`xai-`, which is the xAI API-KEY prefix, so something once passed a provider key as a user_id. The wipe
removed it; worth finding the code path before it recurs.

WHAT WAS BUILT
- scripts/tool-battery-cases.ts, 100 cases over all 15 tools. Every card id, partner code and expected number
  was read out of the live catalog BEFORE the case was written (361 cards, 61 partners, 125
  card_partner_rate rows), so a failure means the tool did not fetch rather than that a fixture was invented.
  Case type carries `nodataWhen` so "the data does not exist for this user" is a third verdict, not a fail.
- scripts/tool-battery.ts, `bun run tool-battery`. Calls tool.execute(input, { requestContext }) directly
  against the real catalog DB, real bureau sidecar and real Exa. Logs a SHAPE summary (field names, which
  came back non-null) rather than payloads, prints a per-tool table and every failure with its reason.
- lib/langfuse-eval.ts, shared by both scripts. Dataset, items, batched trace+score ingestion, and dataset
  run items. Endpoint shapes were taken from the instance's own OpenAPI spec
  (GET https://hipaa.cloud.langfuse.com/generated/api/openapi.yml), not from memory.
- scripts/agent-tool-pass.ts, `bun run agent-tool-pass`. 20 real /v1/chat turns, each asking for a fact that
  exists in exactly one place in the catalog and asserting the digits survive into the reply. This is the
  half the direct matrix cannot cover: it tests tool SELECTION.

RESULT, direct matrix: 92 pass, 5 fail, 0 error, 3 nodata, of 100. Latency p50 261ms, max 2.5s. Per tool,
everything green except getCardFees 7/10, calculateEmi 5/6, calculateFoir 4/5, getStatement 0/3 (all nodata).

RATE LIMIT, worth knowing before re-running. The first attempt reported per case, 4 requests each, ~500 in
total, and the API returned 429 `{limit:100, retryAfterSeconds}` for ALL 100 dataset-run-items. The local
table read 91/100 healthy while the Langfuse experiment was empty, which is the failure mode to watch: local
green plus silent export failure. Fixed by batching traces and scores into ingestion calls (300 events in 3
calls), skipping dataset items that already exist, and honouring retryAfterSeconds on a 429.

LANGFUSE, verified by reading it back rather than trusting the absence of errors: dataset
'credix-tool-fetch', run 'tool-fetch-20260805172808', 100 run items each linked to a trace; 3 scores per
trace (tool_fetch_ok BOOLEAN, tool_latency_ms NUMERIC, tool_verdict CATEGORICAL); 92/100 scored 1, matching
the local count exactly; a failing score carries its reason as the score comment. NOTE for the next reader:
`GET /api/public/v3/scores` does NOT project `comment`, `traceId` or `metadata`, so a score looks empty from
that endpoint. Read `GET /api/public/traces/{id}` instead, which shows the scores attached with comments.
Dataset holds 101 items, one more than the suite: `neg-sig-unknown` from the first run was renamed to
`sig-arg-ignored`, leaving an orphan item with no run items. Harmless, but that is why the count is 101.

TWO HIGH BUGS, both new and neither visible to the persona battery:

1. THE MASTER EMITS ITS DELEGATION CALL AS LITERAL JSON TO THE USER. Turn a-fees-reserve, "Total first year
   cost of the Axis Bank Reserve credit card including GST?", returned a fenced ```json block containing
   [{"name":"agent-creditCardAgent","parameters":{"prompt":"User wants the total first year cost..."}}]
   as the reply body. The user sees raw tool-call syntax instead of an answer. `bun run battery` cannot see
   this: its 10 checks are regexes for internal vocabulary, glued text, dashes, length and PII, and none look
   for a fenced json block or an "agent-" tool name. Fix belongs in code, not a prompt, because it must
   always hold: a check in postGuardrailStep. The underlying question, why the model text-emits the call
   instead of invoking it, still needs answering.

2. getCardFees IGNORES catalog.card.first_year_fee. The column is populated for 80 of 361 cards and
   contradicts the value we compute, in BOTH directions:
     icici_emeralde     first_year_fee=0    we quote ₹14,160  (free first year sold as a full joining fee)
     icici_times_black  first_year_fee=0    we quote ₹23,600
     icici_coral_rupay  first_year_fee=0    we quote ₹590
     rbl_irctc          first_year_fee=500  we quote ₹0       (joining_fee=0, so we call a paid card free)
   This is the same defect class ZT-763 was opened for: D1 was "first year cost of HDFC Infinia" answered by
   summing joining and annual. That fix stopped the summing but still reads the wrong column, so the PR's
   headline fix is incomplete. Needs a decision on which source wins before firstYearNote is changed.

LOWER: calculateEmi returns "EMI: 10403", no ₹ and no Indian grouping and no total interest or payable, so
the model does the money formatting that inr() exists to prevent; calculateFoir returns a bare "FOIR: 75.0%"
with no affordability band though the addendum references banding. Both arithmetic results were verified
independently in python and are correct, so this is presentation only. getStatement is UNVERIFIED end to end
because no statement exists for TEST_MOBILE; the tool correctly returns available=false, which is why those
3 cases report nodata rather than fail.

TWO OF MY OWN TEST CASES WERE WRONG and were corrected rather than filed as tool bugs. The EMI cases asserted
a ₹ sign and were rewritten to assert the independently verified figures (10747, 8979, 21538), with the
formatting gap split into its own clearly labelled case. `neg-sig-unknown` passed user_id 9999999999 in the
tool args and expected available=false; resolveUserId is context-FIRST by design, so the arg is ignored and
the context user wins. That is a security property, not a bug, so the case became `sig-arg-ignored` and now
asserts it.

## 2026-08-06 — no numbers from memory: strict rule moved into the shared persona

User observed the agent leaning on remembered figures. The rules already existed but were unevenly placed,
which is the actual defect:

- agents/persona.ts carried the WEAK form, "if it is not in the profile you were given or in a tool result,
  say you do not have it". A number recalled from an EARLIER turn's tool result satisfies that sentence.
- agents/credit-card.ts:40 carried the strict THIS-turn form, but only creditCardAgent reads that addendum.
  masterAgent and credixAgent therefore had no this-turn requirement at all, and both can state figures:
  credix holds getBureauDetail, getStatement and getSignals, and master merges worker output and carries
  its own exaSearch.

Fixed in the shared persona rather than by copying the rule into two more files. The CRITICAL bullet now
requires every fee, rate, cap, score, limit, balance or count to come from a tool result in THIS turn or the
profile handed over with this turn, and states that an earlier turn, a stored summary or the model's own
previous reply is not evidence.

DELIBERATE EXCEPTION, do not remove it: a figure the USER stated about themselves (monthly spend, income) is
still recalled rather than re-asked. A blanket "no numbers from memory" would have reintroduced the
question-repeat defect, since CREDIT_CARD_ADDENDUM separately requires "If they already told you in this
conversation, never ask again". The two rules would have contradicted each other.

Also added one master-only synthesis line: every figure in the reply must have come back from a worker or a
tool on this turn, and a worker's figure is carried as given rather than rounded, restated or "corrected".
The master is the one agent that can introduce a number while merging rather than while calling a tool.

Drift protection: agents.test.ts now asserts both new strings on ALL THREE agents, plus the master synthesis
line. Suite 340 passing, 22 skipped, 0 failing, 362 tests. tsc clean.

Left in place on purpose: the procedural self-check at credit-card.ts:40. The persona CRITICAL block is
documented as the front-loaded reminder with "the detail is below", so that is the established structure
rather than accidental duplication.

HONEST LIMIT: this is a prompt rule, and the standing lesson in this repo is that what must always hold
belongs in code. A deterministic version would extract every figure from the reply and require it to appear
in this turn's tool results, in postGuardrailStep. Not built, because computed values (an EMI, a 12 month
total, a percentage the model derives correctly) would false-positive, and a guard that cries wolf gets
disabled. Revisit if a battery run shows remembered figures still reaching users.
