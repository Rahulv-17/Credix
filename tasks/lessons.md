# Lessons

- **[TASK STATE] Reuse the active tracker.** When asked to work from `SETUP.md`, do not create a new task or parallel plan; continue the existing `tasks/todo.md` state unless the user explicitly asks otherwise.
- **[GIT] Do not add AI co-author trailers.** Commit history must not include `Co-Authored-By` entries for Claude or other AI assistants.

- **`rm -rf <dir>` destroys gitignored files with no recovery.** During the
  2026-06-19 restructure, `rm -rf snowflake-fetch` also deleted `keys/rsa_key.p8`
  (gitignored, so `git` couldn't restore it). When deleting a folder, first move any
  gitignored secrets/keys out (the plan said relocate to `secrets/`), or `git rm`
  only the tracked files and inspect what's left. Low impact here (password auth is
  active; the key path in `.env` pointed elsewhere) but avoidable.
- **`config/` is a top-level namespace package, not under `src/`.** Import it as
  `config.settings` with the repo root on `sys.path` (pytest `pythonpath = ["src","."]`;
  the CLI inserts both). `credit_credix` is the only package under `src/`.
- **Keep `load_env()` dependency-free.** `config/settings.py` exposes a stdlib
  `load_env()` (the CLI's only need) and guards the `pydantic_settings` import so a
  missing extra never breaks the hot path; `Settings` is only built on demand.

- **Quote numeric-looking YAML keys.** PyYAML reads `30_60` as integer `3060`
  (underscore is a digit separator in YAML 1.1). Unquoted DPD bucket keys became
  int dict keys and broke the BSON/Mongo write. Always quote keys like `"30_60"`.
- **Docker here is podman emulating docker.** `docker exec <name>` may not resolve
  the compose container name — verify Redis/services over the published port, not
  by container name.
- **Canonical user key = bare 10-digit mobile (`mobile_to_user_id`).** As of
  2026-06-09 this replaced the old sha256 `mobile_to_token`; the `captain_ai`
  `user_token` join is out of scope. Normalize country code / `+` / spaces / leading
  0 to the last 10 digits, validate length 10. Snowflake stores 10-digit numbers, so
  the same value keys Redis/Mongo and feeds the L3 query. `tests/test_identity.py` pins it.
- **Bound Mongo freshness in app logic, not a TTL index.** `bureau_data` is an
  immutable per-scrub-month audit — a native `expireAfterSeconds` index would delete
  history. The resolver serves L2 only if `now - fetched_at < BUREAU_FRESH_DAYS` (15),
  fixed window, so new monthly scrubs are always picked up.
- **PII discipline:** full doc (incl. PII) lives only in Mongo (audit); the Redis
  agent cache is always PII-stripped. RedisRepo guards `MODULE LIST` for ReJSON.

## TypeScript / Mastra (src/mastra/)

- **Construct Mastra `Agent`/clients lazily, not at module top-level — or `mock.module` can't reach
  them.** Bun hoists `import` above `mock.module()`, so an agent built at module load uses the REAL
  `@mastra/core/agent` before the test's stub registers (the call then hits the network and throws).
  `understand.ts` builds its classifier agent via a memoised `getUnderstandAgent()` called inside
  `execute`; `decode.ts`/`compose.ts` do the same with `ElevenLabsClient`. Module-level singletons
  (the 4 specialist agents) can't be mocked this way — test them with the REAL `Agent` instead, and
  rely on bun's alphabetical file order (`agents.test.ts` runs before `understand.test.ts`, so the
  barrel is imported before any file mocks `@mastra/core/agent`).
- **Installed Mastra API ≠ the Issue-004 spec snippets (verified against `node_modules` `.d.ts` +
  docs MCP, @mastra/core 1.45.0 / @mastra/memory 1.21.0). Forward-flags for Issue 004.2:**
  1. `memory.updateWorkingMemory({ threadId, resourceId, workingMemory: <string> })` — NOT
     `{ resourceId, threadId, data: {...} }`. Schema-mode memory still takes a string payload.
  2. `result.steps[].toolCalls`/`toolResults` are wrapped in `.payload` — read
     `tc.payload.toolName` / `tc.payload.args` / `tr.payload.result` / `tr.payload.toolCallId`.
     The spec's `makeAgentStep` reads the flat fields → would build an empty `tool_calls_log`.
  3. Registering agents in `index.ts` (004.2) makes an `index → agents → memory → index` cycle;
     it works only because `libsqlStore` is defined before the agents barrel is imported — keep
     that ordering.
- **Structured output:** `agent.generate(msg, { structuredOutput: { schema, errorStrategy:'fallback',
  fallbackValue } })` returns the typed object on `res.object`. Schema-validation failures degrade via
  `fallback`; transport/HTTP errors still throw, so keep the try/catch. Reasoning effort for a thinking
  model goes on the **top-level** `providerOptions.openai.reasoningEffort` (no separate structuring
  model), not inside `structuredOutput`.
- **bun `mock.module` is NOT hoisted above static `import`, and only intercepts bare specifiers
  (confirmed building 004.2).** A static `import` of a module that EAGERLY constructs a mocked
  dependency at load (e.g. the module-level specialist agents calling `new Agent()`) runs before
  `mock.module(...)` registers — so it gets the REAL dependency. Two consequences: (1) lazily-built
  deps (understand's memoized agent, the ElevenLabs client) mock fine with a static import; eager ones
  need a **dynamic `await import(...)` AFTER `mock.module`**. (2) `mock.module('../relative/path')`
  does NOT intercept here — only bare specifiers like `@mastra/core/agent` do. When mocking a whole
  module, **spread the real module** and override only what you need (`{ ...realMod, Agent: Stub }`),
  or you drop other exports it relies on (e.g. `MessageList`) → "Export named X not found". Shared
  harness: `src/mastra/__tests__/agent-mock.ts`.
- **`mastra.getWorkflow(key)` and `getAgent(key)` use the REGISTRATION KEY, not the `id` (built 004.3).**
  We registered `workflows: { credixWorkflow }`, so the server calls `getWorkflow('credixWorkflow')`
  — `getWorkflow('credix-workflow')` (the workflow's own id) throws. Use `getWorkflowById(id)` only if
  keying by id. Run result: `{status:'success', result}` | `{status:'failed', error}` | suspended/tripwire.
- **Make the Hono entry testable: export `app`, gate side-effects behind `isEntry` (built 004.3).**
  `server.ts` had top-level `serve()` + `process.exit` env guards, so importing it in a test bound a
  port / killed the run. Fix: `export const app`, and wrap guards/serve/signal-handlers in
  `if (process.argv[1] === fileURLToPath(import.meta.url))` (true under node & bun entry, false under
  `bun test`). E2E then drives `app.request('/v1/chat', {...})` with no listener.
- **A mocked Mastra `Agent` must EXTEND the real Agent if it'll be registered (built 004.3).**
  `new Mastra({ agents })` calls lifecycle methods on each agent (`__setLogger`, etc.). A bare stub
  class crashes registration. The shared harness stub `extends realAgentModule.Agent` and overrides
  only `generate`/`getMemory`. (Standalone `workflow.test` ran the workflow directly so it didn't hit
  this; `e2e.test` imports the registered `mastra`, so it does.)
- **Break ESM import cycles with a dedicated leaf module, not import ordering (built 004.2).**
  `index.ts` registering agents created `index → agents → memory → index`. You CANNOT fix it by
  "declaring `libsqlStore` before the agents import" — ESM hoists all imports above const decls, so
  `memory` reads `libsqlStore` before it initialises. Fix: move `libsqlStore` to its own
  `lib/storage.ts`; both `index.ts` and `memory/index.ts` import the leaf → no cycle.
- **Workflow schema continuity is unforgiving — trace it before assembling (found prepping 004.2).**
  `.branch()` requires every branch step to share ONE input schema and ONE output schema. After
  `.branch()` use `.map()` + `getStepResult(STEP_IDS.*)` to collapse to one shape. A step's output is
  the next step's whole input — fields a step doesn't re-emit are GONE (e.g. `postGuardrailStep`
  `{raw_response}→{response}` drops `active_skill`). `composeStep` reads `response`/`channel`/
  `session_id`/`active_skill` from **inputData**, not `getInitData()`, so it needs an explicit
  `.map()` seam feeding it. `bunx tsc --noEmit` is the cheapest gate — it fails on every seam mismatch.

- **OM's auto observe-on-turn trigger does not fire via `agent.generate` (found 2026-07-03).**
  Enabling `observationalMemory` on Memory creates the engine and injects observation context on read,
  but the WRITE trigger never fired through the workflow's non-streaming `agent.generate` (nor
  `.stream`): `processInputStep` runs and logs `msgs=<n>/<threshold>` over the limit, yet no
  observation is produced. `engine.observe()`/`engine.finalize()` called directly work fine. Drive OM
  explicitly at end of turn from the `memory-writeback` step: `getStatus()` (pure read, no LLM) gates
  `finalize()` (activate+observe) and a re-checked `reflect()`. Debug with `OM_DEBUG=1` -> writes
  `om-debug.log` in cwd.
- **OM's `model` accepts a LanguageModel instance, not just a `provider/model` string.**
  `ObservationalMemoryModel = Exclude<AgentConfig['model'], undefined> | ModelByInputTokens`. Reuse the
  agents' existing `grokModel` (xAI via GROK_API_KEY) as Observer/Reflector — no Google/xAI-router key
  needed. Default OM model is `google/gemini-2.5-flash`, which this project has no key for.
- **OM thread scope requires a threadId or it THROWS** (`getThreadContext`). The workflow passes
  `memory: { resource: user_id, thread: session_id }`, so every agent turn is fine; but any bare
  `agent.generate` without a thread would throw once OM is on. Resource scope is experimental +
  disables async buffering — keep thread scope unless you deliberately want cross-session observations.

- **Verify latency against the REAL trace, not stdout — and not a single turn.** A one-turn probe read
  12.4s and I called the latency fix landed; the 3-turn Honeycomb trace showed ~21s/turn was intact. Pull
  `get_trace` + `get_span_details` (Honeycomb MCP, service `credix-mastra`, env `test`) and read per-span
  durations + custom attrs (`app.tool_calls.count`, `app.web_grounding.used`, `app.bureau.cache`) before
  claiming a win. `bun run probe` (multi-turn) is the driver; each session is ONE trace.
- **Model tier != latency for structured classification.** Swapping `understand.classify` from grok-4.3
  (reasoning) to grok-3 did NOT cut its ~6s — the cost is the structured-output brief (intent + summary +
  2-5 points), not the model. When an LLM step is slow, check what it's asked to PRODUCE before blaming the model.
- **Specialists still tool-call even when the data is in the prompt.** Injecting the full `masked_profile`
  into the prompt (credix-workflow makeAgentStep) only stopped `getBureauProfile` on 1 of 3 intents;
  `app.tool_calls.count` was still 1 on the others. Also Exa web-grounding (`groundWithWeb`) is ON whenever
  `EXA_API_KEY` is set and adds a POST per substantive turn under `agent.generate`. Persona wording alone
  doesn't reliably suppress tool use.
- **The bureau in-process cache is per-PROCESS, not shared.** `profileCache` (a module-level `Map` in
  `lib/bureau-fetch.ts`) lives in one Node process's V8 heap (ESM singleton). The probe, the Hono server,
  `bun test`, and Mastra Studio each hold their own; a fresh process starts cold (turn 1 = `app.bureau.cache=miss`).
  The fleet-wide shared cache is the sidecar's Pogocache/Redis L1 (:9401) — do NOT add a second TS-tier Redis
  (duplicates L1 + doubles PII-at-rest). Only `ok` is cached; not_found/error must re-try.
- **A cache-hit still opens the `bureau.fetch` span (marked `app.bureau.cache=hit`, ~0ms, no `tcp.connect`
  child).** Keeping the span on the hit path is deliberate — the trace still shows the bureau step and the
  hit/miss attribute is a ready-made cache-hit-rate metric.

- **One shared mock factory per memoised singleton, never per-file inline stubs (built latency Phase B).**
  `tools/exa.ts` memoises its client on FIRST search, so whichever test file's `mock.module('exa-js', ...)`
  constructed it wins for the whole `bun test` process — understand.test literally received
  workflow.test's stub results. Same root cause the agent harness already solved: register ONE factory
  (`__tests__/exa-mock.ts`, pattern of `agent-mock.ts`) and drive behaviour via shared mutable state.
- **npm undici's `setGlobalDispatcher` DOES steer Node's built-in fetch — same-major only.** The
  dispatcher lives at cross-realm `Symbol.for('undici.globalDispatcher.1')`, shared between the npm
  copy and the bundled copy; pin the npm major to the runtime's bundled major (Node 20/22 = 6.x,
  `process.versions.undici`; Node 24 = 7). Default `keepAliveTimeout` is 4s — shorter than a chat
  turn gap, so every turn re-handshook TLS until `lib/http-dispatcher.ts` (60s) landed. Verified on
  trace 115eb5c4...: turn-2+ exa/x.ai POSTs have no tls.connect children.
- **Classify latency anatomy is now fully mapped: the residual ~3s is xAI-side.** Intent-only
  structured output cut understand.classify 5.24s -> ~3.2s, and the custom span ≈ the undici POST
  span (Mastra overhead ~10ms), so what remains is server TTFB/queueing, not model tier (ruled out
  2026-07-07) and not output tokens (ruled out 2026-07-08). Next lever if needed: response_format
  json_object via direct chat.completions (git 59153fe) to skip strict-schema grammar.
- **Two CONCURRENT x.ai POSTs under agent.generate with `app.tool_calls.count=0` is NOT a tool loop
  and NOT OM.** Tool loops are sequential; om.writeback attrs (`observed=false`) prove OM idle.
  Suspect the Mastra memory pipeline (working-memory update) — it fires in parallel and generate
  awaits it, so the SLOWER call sets turn latency (trace 115eb5c4... turn 3: 13.28s vs 9.75s).
- **Podman inside the VSCode snap: strip the snap env before calling it.** The snap remaps HOME per
  revision, so podman's libpod DB path mismatches after a snap refresh ("database static dir ...
  does not match"). `env -i HOME=/home/beast PATH=$PATH podman <cmd>` uses the real storage and
  works (`make cache-up` fails as-is inside the IDE terminal).

- **The bureau profile that reaches the TS runtime is CATEGORIZED and PII-STRIPPED.** `/internal/
  bureau/{id}` returns `strip_secure(doc)`, dropping the whole `pii` section (PAN/DOB/name/phones/
  addresses; `secure: true` in scrub_mapping). Anything needing those fields (age, PAN-type,
  address stability) must be computed in the Python sidecar at materialize time, NOT in .ts after
  fetch. engine_full.py's age/PAN/address signals cannot be reproduced downstream.
- **A persona signal engine already existed end to end before engine_full.py.** user_story/signals.py
  compute_signals -> UserStoryStore (L1 Pogocache + L2 Mongo) -> /internal/user-story/{id} ->
  steps/user-story.ts (stub). Always grep for the existing pipeline before building a parallel one;
  the right move was upgrade + reuse (bump SIGNALS_VERSION so stored docs re-materialize).
- **Port-by-flat-adapter beats hand-porting field accesses.** engine_full.py reads a FLAT scrub row
  with inconsistent key casing (financial UPPER `HL_ALL`, DPD mixed `<30DPD_12mon`). Copying the
  tier functions VERBATIM and feeding them a `_to_flat(doc)` reconstruction (inverse of
  scrub_mapping) gives parity by construction; a 100-user parity test vs the reference pins it.
- **The normalizer is lossy for pii list fields + unmapped columns.** It drops None entries from
  scalar-list fields (addresses/phones lose positions) and never carries PASSPORT/VOTER/DL/MOBILE.
  So GLOBAL_MOBILITY_FLAG, PASSPORT_FLAG, KYC depth, DL_FLAG, PHONE_REACHABILITY_COUNT degrade to
  None post-normalize; that is expected, not a bug. Exclude them from strict parity, assert the
  degradation explicitly.
- **pytest is a dev-extra, not in the base venv.** Run tests with `uv run --extra dev python -m
  pytest ...` (plain `pytest` / `uv run pytest` fail with "No module named pytest").
- **The mastra app lives in src/mastra/ (its own package.json).** `bun test` and `tsc --noEmit`
  run from there; the repo-root `verify` skill only covers Python + interface/, so verify the
  src/mastra TS side separately (bun test + tsc) when touching it.

- **pg `numeric` columns arrive as STRINGS; cast to float8 in SQL or zod validation fails (built
  card-catalog 2026-07-13).** node-postgres returns `integer`/`float8`/`double precision` as JS
  numbers but `numeric`/`decimal` as strings (to preserve precision). A tool whose outputSchema
  declares `z.number()` will fail Mastra output validation on a numeric column. Fix in the SELECT:
  `annual_fee::float8 AS annual_fee`, `fx_markup_pct::float8 ...`, `(CASE ... END)::float8 ...`.
  Cred's tools that returned rows raw got away with it only where the columns were `integer`.
- **Mock `pg` by the bare specifier + a lazy pool getter (built card-catalog 2026-07-13).**
  `lib/catalog-db.ts` builds the Pool lazily via `getCatalogPool()` (memoised) with a
  `resetCatalogPoolForTests()` seam, and never at import time (so a missing DATABASE_URL can't crash
  a fresh clone / bun test — tools check null and return CATALOG_DB_UNAVAILABLE). Tests
  `mock.module('pg', () => ({ Pool: StubPool }))` (bare specifier intercepts, unlike relative paths),
  set `DATABASE_URL` BEFORE the dynamic `await import('../tools/card-catalog')`, and drive canned
  rows/errors from mutable module state. `resetCatalogPoolForTests()` in `beforeEach` re-reads env so
  the DB-unavailable case can be exercised by `delete process.env.DATABASE_URL`.
- **Catalog tools are fail-soft and PII-free.** Card reference data is public product info, so it
  does NOT pass the PII firewall and the span records only counts/outcomes (`app.catalog.match_count`,
  `app.catalog.available`), never card queries. On a catalog miss the tool returns `{ ok:false }` and
  points the agent to `exaSearch` (Credix has no embedded web-fallback inside the tool, unlike
  Cred's `card-web-fallback.ts` which we deliberately did not port).
- **Multi-query tools need a SQL-text `responder` stub, not a single `nextRows` (built catalog batch 2).**
  getCardFees/Benefits/PartnerRates each issue several queries (card lookup + resolveCardCandidates +
  benefit/lounge/network-tier). The pg stub in `__tests__/card-catalog.test.ts` routes rows by
  matching the SQL text (`text.includes('joining_fee')` vs `'SELECT id, name FROM catalog.card'` vs
  `'FROM catalog.card_benefit'` ...). A single shared `nextRows` would feed benefit-shaped rows to the
  candidate query. `beforeEach` resets `responder = () => nextRows` so single-query tests still work.
- **Porting Cred catalog tools: drop 3 things, keep the SQL.** (1) `makeProgress`/`writer.custom`
  (playground). (2) `card-web-fallback` (Credix's exaSearch is a separate tool). (3) `toModelOutput`
  — BUT its text encodes real narration-correctness rules found via live hallucination audits (year-one
  fee = joining only; insurance covers are protection LIMITS never summed into value; "up to" for
  maximums; is_instant_discount != reward points; edition-ambiguity disclosure). Dropping it means
  those rules MUST be re-homed in the agent instructions, else the model may narrate wrong numbers.
  Keep the execute() SQL + shaping verbatim (it's the product); only adapt imports + fail-soft shape.
- **A card can legitimately have 0 partner_rate rows (domain fact, not a bug).** Live smoke:
  getCardPartnerRates({card:'Infinia'}) returns 0 rows because Infinia's accelerated rates are modeled
  as CATEGORY rates (catalog.card_category), not catalog.card_partner_rate. The reverse lookup
  (partner-only) and other cards return rows fine. Don't "fix" an empty partner list for such cards.
- **Live tests need `bun test --env-file=../../.env` — bun loads .env from CWD, not the repo root.**
  The repo-root `.env` (GROK_API_KEY, DATABASE_URL) is two levels up from `src/mastra`; `bun test`
  alone silently sees none of it, so a gated live suite skips ("0 pass, 8 skip") even with the
  LIVE_* flag set. Pass `--env-file=../../.env` explicitly (the dev script uses node's
  `--env-file-if-exists=../../.env` for the same reason).
- **Stable OM thread keys leak memory ACROSS live runs and make the agent skip tool calls (found
  running the catalog live test).** With credixMemory's Observational Memory on, keying
  `agent.generate({ memory: { thread } })` by a stable string means run 2 answers run 1's questions
  from working memory/observations — `tools=[]` yet the reply still has the right catalog numbers.
  A live tool-correctness test MUST use a per-run-unique thread (`live-${Date.now()}-${label}`), or it
  passes once then "fails" (no tools called) on every rerun. Date.now() is fine in a bun test (only
  Workflow scripts ban it).
- **A card-criteria question on a card with a NULL score_floor makes the agent burn maxSteps and
  return empty text (found in the catalog live e2e).** For "income + score to qualify for Axis Atlas"
  the agent ran getCardCriteria -> exaSearch -> getCardCriteria (score_floor is null in the catalog),
  hit maxSteps:3, and produced empty final text. The tool is CORRECT (fired + returned data); the
  workflow's makeAgentStep masks the empty text with a fallback so the user never sees blank. The fix
  is the credit-card instruction addendum: treat the catalog as source of truth, say "not published"
  for a null field instead of web-searching it, and don't re-call the same tool.
- **Live tool-correctness: assert TOOL-FIRED + TOOL-RETURNED-DATA, not final text.** The correctness
  contract for a catalog tool is "the LLM invoked it and it returned real data (not the fail-soft
  shape)"; final answer text is a soft check (agents vary which allowed tool they pick — fees was
  answered via getCardFees on one run and getCardDetails on another — and can exhaust maxSteps).
  Gate: `src/mastra/__tests__/card-catalog.live.test.ts` (LIVE_CATALOG=true, run in isolation).
- **Copilot re-reviews on EVERY push while it is a requested reviewer, so the co-review loop must poll
  after each push, not just once.** On PR #15 each fix-push spawned a fresh Copilot wave (6 -> 5 -> 0).
  The loop is event-gated: after a push, poll for a Copilot review with submittedAt > baseline, with a
  ~12 min no-new-review timeout as the convergence signal. To kick off a review on a head Copilot has not
  seen (e.g. right after fixes land), re-request it: GraphQL requestReviews(pullRequestId,
  botIds:[<copilot bot id>], union:true). The bot id is on any prior Copilot review author.
- **Content-preserving history linearization: `git rebase -X theirs <base>` + a tree-hash equality gate.**
  When a branch's only non-linearity is a merge-of-base commit, plain `git rebase <base>` replays ALL
  commits from the old merge-base and conflicts from commit 1 (branch work overlaps the base's own
  changes). `-X theirs` auto-resolves those toward the branch; structural conflicts (rename/delete) still
  need a manual call. The guarantee is the invariant check BEFORE force-push: the new tree hash MUST equal
  the pre-rebase tip's (`git rev-parse <pre>^{tree}` == `HEAD^{tree}`); if it differs, abort. Then
  force-push-with-lease. Content provably unchanged => no re-test needed.
- **card_lounge base rows use tier=NULL; `tier NOT IN (...)` silently drops them (SQL three-valued
  logic).** Any "base tier only" lounge filter must be `(tier IS NULL OR tier NOT IN ('gold','platinum'))`.
  Evidence base rows are NULL-tier: getCardBenefits orders `tier NULLS FIRST` and formats a null tier as
  the base row. This bit 3 queries (getCardDetails, compareCards, attachLounge).
- **A rebased+force-pushed BASE branch makes a stacked PR show phantom conflicts on every base commit.**
  When PR #14's base was linearized (bureau-python-wrapper force-pushed to 47d9fac), the child PR #15
  (cred-catalog-tools, stacked on the OLD base) went CONFLICTING/DIRTY: GitHub 3-way-merges against the
  new base and sees the ~57 rewritten commits as divergent even though content is identical. This is NOT
  a real conflict. Diagnose with `git cherry -v <newbase> <branch>`: `+` = genuinely unique commits to
  keep, `-` = patch-identical duplicates already in the new base. The last `-` before the first `+` is the
  fork point. Fix with `git rebase --onto <newbase> <forkpoint> <branch>` to replay ONLY the `+` commits;
  it is conflict-free when your unique commits touch different files than the rebased base commits. Always
  `git branch backup/<name> <old-remote-tip>` before force-push-with-lease so the pre-rebase PR state is
  recoverable. A plain `git merge <newbase>` or `git rebase <newbase>` (no --onto) would instead replay
  from the ancient merge-base and drown you in the duplicate-commit conflicts.

## Before calling a Cred tool a "port", check BOTH its full import set AND whether catalog-cards.ts already superseded it (2026-07-15)
`recommendCard` looked like a clean port until the full import block showed `recommend-card.ts` pulls the
pid path from `lib/cards.ts` (getEligibleCards/getUserSpend/getFunnel) over `usr.*` tables Credix never
fills. But Credix's `lib/catalog-cards.ts` already ported `rankCardsForInterview()`, which calls the
param-based `catalog.rank_cards_for_spend(...)` and supersedes Cred's logic entirely. Lesson: (1) grep the
WHOLE import block, not the first 4 lines; a tool can depend on an unported/out-of-scope lib midway down.
(2) Before scoping a Cred tool as port/wrap/rewrite, grep Credix `lib/catalog-cards.ts` for an existing
helper that already does the job. Do not assume "imports resolve cleanly" from a partial read.

## A `_STG`/staging table in a runtime query is a copy-paste from pre-processing, not a real source (2026-07-16)
SQL_BY_MOBILE 500'd on `GENERAL_INFO_SCORE_STG does not exist or not authorized`. The join
was lifted verbatim from the app's ETL/pre-processing SQL, where staging tables are ephemeral;
the runtime resolver connects to a different db/schema where they don't exist. Tell: (1) the
sibling queries (SQL_BY_ID/SQL_TOP) omit it, (2) the column it produced (SCORE_STG) was read
by NOTHING in the repo. Lesson: when one of several near-identical queries fails on a missing
object, diff it against the working siblings first; a `_STG`/`_TMP`/`_RAW` name that appears in
only one query and whose output is unconsumed is dead pre-processing residue, delete it rather
than chasing a grant.

## A rule aimed at the model must not live in a string the model quotes to the user (2026-08-05)
`getCardFees.first_year_note` shipped as `...The annual fee of 14750 applies from renewal in year 2. Do NOT
add the two together for year one.` The tool-output-over-prompt instinct was right (right-card 7d6cb0c: a
prompt rule can be skipped, a field arriving with the numbers cannot), but the addendum also tells the agent
to "quote those", so the imperative was one prompt away from being read out to a user. Copilot caught it on
PR #20. Lesson: when putting a rule in tool OUTPUT, split it. The user-facing sentence goes in the string
the model quotes, digits and ₹ and no imperatives; the instruction to the model goes in the addendum. If a
field's own docstring says the model should repeat it, everything in it is user-facing text and the persona
rules (₹ sign, digits, no dashes) apply to it exactly as they do to a reply. Test for it: assert every
branch of such a string contains no "do not"/"never" (see partner-math.test.ts).

## Two bounded-map implementations in one repo means the second one is a bug waiting (2026-08-05)
`lib/session-state.ts` shipped `capMapSize()`, a fresh insertion-order size guard, while `lib/ttl-cache.ts`
had already solved the same problem for the bureau cache. The new one was wrong in a way the old one was
not: `Map#set` on an EXISTING key does not move it in insertion order, so re-setting a live session's state
every turn never refreshed its position and a 40-turn session was as evictable as an abandoned one. The
comment even claimed "LRU". Lesson: before writing an eviction/bound/cache helper, grep lib/ for one; and if
you write a comment claiming a policy (LRU, FIFO), verify the data structure actually implements it, because
Map is insertion-ordered, not access-ordered.

## Check which RUNTIME a package script uses before relying on a runtime-specific global (2026-08-05)
Making `scripts/battery.ts` importable needed a "only run when invoked directly" guard. `import.meta.main`
worked when tested with `bun scripts/battery.ts`, but `bun run battery` actually shells out to
`node --import tsx/esm scripts/battery.ts`, and `import.meta.main` only exists on Node >= 24.2. This repo
pins no version anywhere: no engines field, no CI workflow, no Dockerfile. On an older Node the property is
simply `undefined`, so `if (import.meta.main) void main()` is silently false and the battery would look like
it ran while doing nothing. Lesson: (1) read the package.json script before testing a script by hand, the
runner is often not the one you are typing; (2) prefer the argv comparison
`fileURLToPath(import.meta.url) === resolve(process.argv[1])`, same length and no version floor; (3) a guard
whose failure mode is "silently does nothing" deserves the boring option, especially on a script whose whole
job is to produce measurements someone will trust.

## Scrub at the disk/wire boundary, never before the detector runs (2026-08-05)
The battery's `pii` check exists because a reply CAN contain a PAN, and the row written to disk kept both the
raw reply and that check's matched `evidence`. The fix is `scrubIdentifiers` at the `appendFileSync` call, and
the ordering is load-bearing: scrubbing any earlier would leave the check matching on already-redacted text,
so it could never fire again, and `repeat-reply` compares against replies held in memory which must stay like
for like. Lesson: when adding redaction to a pipeline that also DETECTS the thing being redacted, the scrub
goes at the egress point and returns a copy, never in place. Write the reason in the code, because the
"obvious simplification" of moving it earlier silently disables the detector rather than breaking a test.

## "Generated no new comments" from Copilot can still hide findings in a suppressed block (2026-08-05)
Copilot's review of d030609 on PR #20 opened with "Copilot reviewed 29 out of 29 changed files and
generated no new comments", and the thread API agreed at unresolved=0. Collapsed underneath was a
<details> block with SEVEN suppressed comments, two of which were real defects of a class we had just
shipped a fix for. Lesson: the review-thread count is not the whole review. After each push, read the
review BODY, not just the unresolved threads:
  gh api repos/financebuddha/credix/pulls/<n>/reviews --jq '.[]|select(.user.login|test("copilot"))|.body'
Suppressed comments have no thread id, so they cannot be replied to or resolved; they are closed by the
commit and by a note in tasks/progress.md.

## Fix the CLASS, not the line the reviewer named (2026-08-05)
A reviewer flagged a model directive ("Do NOT add the two together") inside `first_year_note`, a tool-output
string the agent is instructed to quote to the user. e17bb3f fixed that string. The next review pass found
the identical defect in `math_note` ("so say it that way") and `no_data_note` ("Do NOT state an earn
rate..."), both in the SAME file, both quoted to the user. The class was "strings the model is told to
repeat"; grepping the agent addendum for "quote"/"repeat that" would have listed all three in one pass.
Lesson: when a review names one instance, derive the predicate, grep for every site, fix them together, and
pin the predicate in a test rather than the instance. The test guard here (MODEL_DIRECTIVE in
partner-math.test.ts) is what makes the fourth site fail loudly instead of shipping.

## A per-item figure passed into a multi-item query fabricates an answer for every other item (2026-08-05)
getCardPartnerRates took monthly_spend, meaning spend at ONE merchant, and card-only mode applied it to all
50 partner rows, so one real number about Swiggy produced confident earn figures for Amazon and IRCTC. The
tell is a scalar input whose description contains "this" or "at this merchant" being read inside a `.map()`
over rows that vary in exactly the dimension the scalar was scoped to. Lesson: when a tool has modes, check
every mode against each optional input, not just the mode the input was added for. Grep the input name and
read each call site; the one where the row set is broader than the input's scope is the bug. Applies equally
to the next such field (a monthly_spend per category, a per-card income), so check it at review time.

## Stale watch/baseline text turns a shipped fix into a recorded defect (2026-08-05)
battery-cases.ts watch strings still said "today nothing handles Hinglish; expect an English reply" and
"compound: expect one dropped" AFTER both were fixed in the same PR. Those strings are not comments, they
are the manual grading baseline a human reads next to each reply, so a grader following them would have
filed the correct new behaviour as a regression. Lesson: a fix that changes expected OUTPUT must update the
expectation text in the same commit, and battery-cases.ts counts as code for this purpose. When closing a
phase, grep the case file for "today", "nothing handles", "expect", and "Phase N target".

## Copilot reviews HEAD and skips intermediate commits, so never poll for a specific SHA (2026-08-05)
After pushing 6fc630c and then a docs commit 5274673, a 12-poll watch keyed to commit_id=6fc630c saw
nothing for 10 minutes while Copilot had already reviewed 5274673, and that review covered the 6fc630c
changes because a review is of the whole PR diff, not one commit. Lesson: poll for any bot review NEWER
than the last one you handled, e.g.
  gh api repos/<o>/<r>/pulls/<n>/reviews --jq '[.[]|select(.user.login|test("copilot|codex"))]|last'
and compare its commit_id/submitted_at against what you have already read. Also: a docs-only push is enough
to trigger a fresh review pass, so do not assume a docs commit is review-neutral.

## Run bun test from src/mastra; the repo root loads a different .env and un-gates live tests (2026-08-05)
`bun test` from /home/beast/Documents/stag/credix picks up the ROOT .env, which sets TEST_AUDIO_URL and
so un-gates two opt-in STT integration tests that then fail with ENOENT on
/home/beast/Downloads/test.mp3. Same code, same commit, reads 326 pass / 2 fail / 17 skip from the root and
323 / 0 / 22 from src/mastra. Lesson: when a suite goes red, check the SKIP count first, not just the fail
count. A skip count that moved means a different set of tests ran, which usually means the environment
changed rather than the code. Then confirm with `git diff origin/<base>...HEAD -- <failing files>`; empty
output means the failure is not yours.

## "No constraint" must be null, never a truthy placeholder (2026-08-05)
Three separate defects on PR #20 were the same shape, and each one overstated or understated a money answer:
dayLabel returned "every day" for an unrestricted offer, so the row was flagged conditional, demoted by
rankByValue and given a "treat this as a ceiling" caveat; is_upper_bound fired on a block size with no
points count, demoting a row with no note explaining why; and monthly_spend, meaning spend at ONE merchant,
was applied across every merchant row in card-only mode. Lesson: when a helper returns a LABEL that a caller
tests for truthiness, the no-constraint case must return null, not a friendly string. Grep for
`Boolean(someLabel)` and `if (label)` and check what the function returns when there is nothing to say. And
when the same predicate drives both a ranking penalty and a user-facing explanation, derive both from ONE
named boolean, or they drift into a penalty nobody can see.

## A tool's prose must not contradict the numbers in the same payload, or its own schema contract (2026-08-05)
math_note said "5% earns ₹750 a month" and then "Paid in EDGE points, not rupees". Both statements shipped to
the model in one string, and the tool's own description documents reward_rate as value-back per rupee, so the
₹ figure was correct and the caveat was wrong. Lesson: when a computed field and a hand-written sentence
travel together, read them as the model will, as ONE paragraph. A caveat that qualifies a number ("treat this
as an estimate because...") is safe; a caveat that denies it ("that is not really rupees") makes the whole
payload untrustworthy and invites the model to pick whichever half it likes. Also check the caveat against
the tool's own schema description, which is the contract the rest of the prompt relies on.

## Verify a reviewer's example before accepting or dismissing the finding (2026-08-05)
Copilot reported that `rate * 100 % 1 === 0` misfires because "0.3 -> 29.999999...". That example is wrong,
0.3 * 100 is exactly 30 in JS, and dismissing the comment on that basis would have been easy and would have
shipped the bug. Brute-forcing all 100 two-decimal rates found 8 real failures including 0.07 (7.000000000000001)
and 0.29 (28.999999999999996), both plausible reward rates that were printing as "7.00%" and "29.00%" to
users. Lesson: an automated reviewer can be right about the defect and wrong about the reason. Reproduce the
claim over the real input domain (a loop, not the one value quoted) before deciding, and record which part of
the report was wrong so the next reader does not trust the example over the code.

## Prefer rounding a plausible input over rejecting it at a tool boundary (2026-08-05)
monthly_spend accepted decimals while everything downstream rounded, so computed.monthly_spend could read
15000.6 while the prose said ₹15,001. The tempting fix is `.int()` on the zod schema, but that turns a model
passing 15000.5 into a failed tool call and a retry. Rounding once at the top of the computation and reading
that value everywhere fixes the disagreement with no new failure mode. Lesson: at an LLM-facing tool
boundary, validation that REJECTS should be reserved for inputs we cannot act on safely; for a value we can
obviously normalise, normalise it and say so in a comment.
