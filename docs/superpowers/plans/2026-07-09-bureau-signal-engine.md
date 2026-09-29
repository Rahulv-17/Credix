# Bureau Signal Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compute the full 62+34 bureau signal set server-side, cache it in-process on the TS side, and let the specialist agents read it (push into the prompt + pull via a `getSignals` tool), all observable in Honeycomb without leaking PII.

**Architecture:** Upgrade the existing persona engine (`user_story/signals.py`) to the `engine_full.py` set via an internal flat-view adapter (so the engine logic ports verbatim and reads the categorized doc at the interface). Reuse the existing materialize -> `UserStoryStore` (L1+L2) -> `/internal/user-story/{id}` chain unchanged. On the TS side add `lib/user-story-fetch.ts` (module cache mirroring `bureau-fetch`), fetch once in `server.ts`, inject a compact summary in `makeAgentStep`, and expose a `getSignals` tool.

**Tech Stack:** Python 3 (FastAPI sidecar, ruff), TypeScript (Mastra, Hono, Bun test, OpenTelemetry).

Spec: `docs/superpowers/specs/2026-07-09-bureau-signal-engine-design.md`

## Global Constraints

- No em/en dashes or hyphen-as-separator in git content; use `;` or `,`.
- Python: `uv run ruff format <file>` + `uv run ruff check <file> --fix` after every edit; node fns `async def` returning dict where applicable; no mutable default args.
- TS: `npx tsc --noEmit` before committing frontend/TS; LangGraph/Mastra message role rules; memoize hook adapters (not relevant here).
- Security: no secrets in source (`os.getenv`); PII never logged; CIBIL scores/financial data never logged plaintext; span attributes NEVER carry user_id/mobile/PAN/Aadhaar/CIBIL score or exact age.
- Numbers as digits, never spelled out.
- One concern per commit; run `verify` before each commit; update `tasks/` in the same turn after each commit.
- PII relaxation (approved): exact age may appear in the signal payload (persona store + TS module cache) but NEVER on a span or in a log.

## File structure

- Create `src/nodes/raw_data/user_story/engine.py` — ported engine (compute_tier1/compute_tier2 + helpers + compose maps + build_compose + _to_flat adapter).
- Modify `src/nodes/raw_data/user_story/signals.py` — compute_signals composes structural (unchanged) + engine output; SIGNALS_VERSION 1 -> 2; classify unchanged.
- Modify `src/nodes/raw_data/user_story/store.py` — stamp `signals["_meta"]["compute_ms"]` in materialize.
- Modify `tests/unit/test_user_story_signals.py` — assert new shape (structural still top-level).
- Create `tests/unit/test_signal_engine.py` — flatten round-trip, tier values, compose gating, parity with engine_full.
- Create `src/mastra/lib/user-story-fetch.ts` — module cache + `user-story.fetch` span.
- Create `src/mastra/lib/signal-summary.ts` — buildSignalSummary(signals) -> PII-safe prompt string.
- Create `src/mastra/tools/signals.ts` — getSignals tool (pull) + `signals.lookup` span.
- Modify `src/mastra/server.ts` — fetchUserStory + pass signals into initData.
- Modify `src/mastra/workflows/credix-workflow.ts` — workflowInput += signals; makeAgentStep injects summary + getSignals hint.
- Modify `src/mastra/agents/credix.ts`, `score-improvement.ts`, `credit-card.ts`, `insurance.ts` — attach getSignals.
- Create `src/mastra/__tests__/signals-tool.test.ts`, `user-story-fetch.test.ts`, extend `integration.test.ts` for the e2e access proof.

---

### Task 1: Port the engine into `user_story/engine.py`

**Files:**
- Create: `src/nodes/raw_data/user_story/engine.py`
- Test: `tests/unit/test_signal_engine.py`

**Interfaces:**
- Produces: `run_engine(doc: dict) -> {"tier1": dict, "tier2": dict, "compose": list[dict]}`;
  `_to_flat(doc: dict) -> dict` (categorized -> flat scrub-row keys).
- compose items: `{"var","value","label","verdict","severity","trust_status"}`.

- [ ] **Step 1: Write failing tests** in `tests/unit/test_signal_engine.py`:
  round-trip `_to_flat(normalizer.transform(sample_flat_row))` recovers key financial keys
  (`SCORE`, `HL_ALL`, `<30DPD_12mon`, `TOTAL_INSTITUTE`); `run_engine(doc)` returns tier1 with
  `AGE_EXACT` when `pii.age` present; tier2 has 34 keys; `compose` drops unfired binary flags,
  `not_computable`, and `needs_retest`, and is severity-ranked.
- [ ] **Step 2: Run, verify fail** `uv run pytest tests/unit/test_signal_engine.py -v` (import error).
- [ ] **Step 3: Implement `engine.py`:**
  - Copy `engine_full.py`'s `safe`, `parse_institute_counts`, `compute_tier1`, `compute_tier2`
    VERBATIM (they read a flat `u` dict).
  - Copy `TRUST_STATUS`, `SEVERITY`, `SEVERITY_RANK`, `BINARY_FLAGS`, `LABELS`.
  - Add `build_compose(t2)` returning the gated, severity-ranked structured list (port
    `get_compose_signals` gating: skip None / not_computable / needs_retest / unfired binary /
    Mass tier; each item `{var,value,label,verdict,severity,trust_status}`).
  - Add `_to_flat(doc)` generic inversion of `config/scrub_mapping.yaml`:
    scalar sections -> `flat[SF_col.upper()] = doc[sec][out_key]`; pii list fields zip SF-col list
    with value list (`phones`->PHONE_1..5, `address_1`->ADDRESS_1/_ZIP/_STATE/_RPTDATE);
    product sections -> `flat[f"{P}_{suffix}".upper()]` (Total->TOTAL, CC extras ->
    CC_UTILIZATION_PCT/CC_MAX_CREDITLIMIT); list suffixes (borrowing_window) emit each alias upper;
    institution -> `flat[f"{P}_INSTITUTE"] = block.raw` (Total->TOTAL_INSTITUTE, Mfbl->MFBL_INSTITUTE);
    dpd -> `flat[f"{prefix}_{month}"]` with prefix from first alias (lt30-><30DPD, 30_60->30-60DPD,
    60_90->60-90DPD, 90_plus->90+_DPD) and month m3->3mon, m12->12mon; pl_fields -> PL_<name>.upper().
  - `run_engine(doc)`: `u=_to_flat(doc); t1=compute_tier1(u); t2=compute_tier2(u,t1);
    return {"tier1":t1,"tier2":t2,"compose":build_compose(t2)}`.
  - Load scrub_mapping once at module import from `config/settings.py` path or a passed path
    (reuse the same config the Normalizer uses; import the loaded dict rather than re-reading if a
    shared loader exists).
- [ ] **Step 4: Run tests** `uv run pytest tests/unit/test_signal_engine.py -v` -> PASS.
- [ ] **Step 5: ruff** `uv run ruff format src/nodes/raw_data/user_story/engine.py tests/unit/test_signal_engine.py && uv run ruff check --fix src/nodes/raw_data/user_story/engine.py`.
- [ ] **Step 6: Commit** `git commit -m "signal-engine: port engine_full 62+34 set into user_story/engine.py with flat-view adapter; verbatim engine logic keeps parity"`.

### Task 2: Wire engine into `compute_signals` + version bump + compute_ms

**Files:**
- Modify: `src/nodes/raw_data/user_story/signals.py`
- Modify: `src/nodes/raw_data/user_story/store.py`
- Test: `tests/unit/test_user_story_signals.py`

**Interfaces:**
- `compute_signals(doc) -> {**structural, "tier1", "tier2", "compose"}` (structural keys unchanged).
- `classify(signals)` unchanged signature/behavior.

- [ ] **Step 1: Update tests** in `test_user_story_signals.py`: existing `["segment"]`,
  `["income_reliable"]`, `["DEMAND_COOLED"]`, `classify` assertions stay (structural preserved);
  add `compute_signals(full_doc)["tier2"]` has 34 keys and `["compose"]` is a list.
- [ ] **Step 2: Run, expect fail** `uv run pytest tests/unit/test_user_story_signals.py -v`.
- [ ] **Step 3: Implement:** rename the current `compute_signals` body to `_structural_signals(doc)`;
  new `compute_signals(doc)` returns `{**_structural_signals(doc), **run_engine(doc)}`
  (import `run_engine` from `.engine`). Bump `SIGNALS_VERSION = 2`. In `store.materialize`, time the
  compute: `t0=time.monotonic(); sig=compute_signals(doc); sig.setdefault("_meta",{})["compute_ms"]=round((time.monotonic()-t0)*1000,2)` and store `sig`.
- [ ] **Step 4: Run tests** `uv run pytest tests/unit/test_user_story_signals.py tests/unit/test_signal_engine.py -v` -> PASS.
- [ ] **Step 5: ruff** on both edited files.
- [ ] **Step 6: Commit** `git commit -m "signal-engine: compute_signals emits full tier1/tier2/compose; SIGNALS_VERSION 2; stamp compute_ms"`.

### Task 3: TS module cache `lib/user-story-fetch.ts`

**Files:**
- Create: `src/mastra/lib/user-story-fetch.ts`
- Test: `src/mastra/__tests__/user-story-fetch.test.ts`

**Interfaces:**
- Produces: `fetchUserStory(user_id) -> {ok:true, signals} | {ok:false, notFound:true} | {ok:false, status}`;
  `clearUserStoryCache(): void`.

- [ ] **Step 1: Write failing test** mirroring `bureau-fetch.test.ts`: mock `fetch` to return
  `{signals:{...}}`; assert ok + signals; second call is a cache hit (no second fetch); 404 -> notFound;
  500 -> `{ok:false,status:500}`; `clearUserStoryCache()` drops the entry.
- [ ] **Step 2: Run, verify fail** `bun test src/mastra/__tests__/user-story-fetch.test.ts`.
- [ ] **Step 3: Implement** by copying `bureau-fetch.ts` structure: same in-proc TTL Map
  (`USER_STORY_CACHE_TTL_MS` default 900_000, `USER_STORY_CACHE_MAX` default 1000), GET
  `${BUREAU_SIDECAR_URL}/internal/user-story/${encodeURIComponent(user_id)}` with `X-Internal-Token`,
  return `body.signals`. `user-story.fetch` span with PII-safe attrs only
  (`app.story.result`, `app.story.cache`, `app.story.http_status`, and `app.story.compute_ms` from
  `signals._meta.compute_ms` when present). Cache only `ok`.
- [ ] **Step 4: Run test** -> PASS.
- [ ] **Step 5: Commit** `git commit -m "signal-engine: add lib/user-story-fetch in-process signals cache + user-story.fetch span"`.

### Task 4: Fetch signals in Hono + thread through the workflow

**Files:**
- Modify: `src/mastra/server.ts`
- Modify: `src/mastra/workflows/credix-workflow.ts` (input schema only in this task)

- [ ] **Step 1:** In `server.ts`, after the `fetchBureau` ok block, add
  `const story = await fetchUserStory(user_id)` and `signals = story.ok ? story.signals : undefined`
  (non-fatal on miss/error). Add `signals` to the workflow `inputData`.
- [ ] **Step 2:** In `credix-workflow.ts`, extend `workflowInput` with
  `signals: z.record(z.string(), z.unknown()).optional()`.
- [ ] **Step 3:** `npx tsc --noEmit` -> clean.
- [ ] **Step 4: Commit** `git commit -m "signal-engine: fetch signals once in Hono, pass into workflow initData"`.

### Task 5: `getSignals` tool + attach to agents

**Files:**
- Create: `src/mastra/tools/signals.ts`
- Modify: `src/mastra/agents/credix.ts`, `score-improvement.ts`, `credit-card.ts`, `insurance.ts`
- Test: `src/mastra/__tests__/signals-tool.test.ts`

**Interfaces:**
- `getSignals` tool: input `{user_id: string, section?: 'tier1'|'tier2'|'compose'}`, output the
  signals payload (or the requested section); `{available:false}` when absent.

- [ ] **Step 1: Write failing test**: prime the module cache via `fetchUserStory` (mocked fetch),
  call `getSignals.execute({user_id})`, assert it returns `tier1/tier2/compose`; `section:'compose'`
  returns the list; unknown user -> `{available:false}`.
- [ ] **Step 2: Run, verify fail** `bun test src/mastra/__tests__/signals-tool.test.ts`.
- [ ] **Step 3: Implement** `tools/signals.ts` using `createTool`; read from the `user-story-fetch`
  cache (fallback to `fetchUserStory` on a miss); `signals.lookup` span with PII-safe attrs
  (`app.signals.present`, `app.signals.compose_count`, `app.signals.affluence_tier`,
  `app.signals.file_tier`). Attach `getSignals` in each agent's `tools: {...}`.
- [ ] **Step 4: Run test + tsc** -> PASS + clean.
- [ ] **Step 5: Commit** `git commit -m "signal-engine: getSignals tool (module-cache pull) wired into specialist agents"`.

### Task 6: Inject signals summary into the specialist prompt

**Files:**
- Create: `src/mastra/lib/signal-summary.ts`
- Modify: `src/mastra/workflows/credix-workflow.ts` (makeAgentStep)
- Test: extend `src/mastra/__tests__/workflow.test.ts` or `integration.test.ts`

**Interfaces:**
- `buildSignalSummary(signals: Record<string, unknown> | undefined) -> string` (PII-safe: segment,
  file_tier, life_stage, and top-3 compose `label: verdict` bullets; `''` when absent).

- [ ] **Step 1: Write failing test**: `buildSignalSummary(sample)` includes the compose labels and
  omits nothing sensitive; empty input -> `''`.
- [ ] **Step 2: Run, verify fail**.
- [ ] **Step 3: Implement** `signal-summary.ts`; in `makeAgentStep`, read
  `init.signals`, compute `const signalSummary = buildSignalSummary(init.signals)`, add a
  `signalSummary` line and a getSignals hint to the `prompt` array (only when non-empty).
- [ ] **Step 4: Run test + tsc** -> PASS + clean.
- [ ] **Step 5: Commit** `git commit -m "signal-engine: inject PII-safe signal summary into specialist prompts (push path)"`.

### Task 7: End-to-end access proof + verify

**Files:**
- Modify: `src/mastra/__tests__/integration.test.ts` (or new `signals-e2e.test.ts`)

- [ ] **Step 1:** Write an integration test that boots `app` (no port), mocks the sidecar
  (`fetchBureau` + `/internal/user-story` via the existing sidecar-mock pattern) to return a known
  signals payload, POSTs `/v1/chat`, and asserts EITHER the specialist prompt received the summary
  (spy on the agent-mock's captured prompt) OR `getSignals` appears in `tool_calls_log`. This proves
  the agent can access the computed signals.
- [ ] **Step 2: Run** `bun test` (full TS suite) -> green.
- [ ] **Step 3: Python** `uv run pytest tests/unit -q` -> green; `uv run ruff check src/nodes/raw_data/user_story` clean.
- [ ] **Step 4: Verify** run the `verify` skill; then optional live smoke (`bun run probe`) if the
  local stack (pogocache + uvicorn sidecar) can be brought up, to confirm real signals flow.
- [ ] **Step 5: Commit** `git commit -m "signal-engine: e2e test proving the agent reads computed signals"` and update `tasks/`.

## Self-review

- Spec coverage: engine upgrade (T1,T2), reuse plumbing (T2 store), module cache (T3), single fetch (T4), agent access pull (T5) + push (T6), tracing (T3 fetch span, T5 lookup span, compute_ms passthrough), e2e (T7). PII relaxation scoped in T1/T2 (payload) and enforced off-span in T3/T5. Covered.
- Placeholder scan: engine port is "copy verbatim + adapter" with the adapter rules enumerated; no TBD.
- Type consistency: `run_engine`/`_to_flat`/`build_compose` (Py), `fetchUserStory`/`clearUserStoryCache`/`buildSignalSummary`/`getSignals` (TS) named identically across tasks.
