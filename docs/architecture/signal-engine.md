# Bureau Signal Engine (`engine.py`)

Reference doc for the signal engine shipped on `feat/bureau-python-wrapper` (2026-07-09).
Covers what `engine.py` computes, how it computes it, and how the output threads through the
whole request flow from Snowflake to the specialist agent's prompt.

Source: [engine.py](../../src/nodes/raw_data/user_story/engine.py) (925 lines, ~33 KB).

---

## 1. What it is (one paragraph)

- `engine.py` turns a single user's **categorized bureau document** into a rich, agent-facing
  **signal set**: 62 Tier-1 base variables + 34 Tier-2 composite signals + a gated, severity-ranked
  `compose` list.
- It is a **verbatim port** of the root `engine_full.py` reference, wrapped with an adapter so it
  runs against the doc shape we actually store (categorized + PII-stripped) rather than the raw
  Snowflake row the reference was written against.
- It runs **server-side in the Python sidecar, at materialize time**, while the doc still holds PII,
  so PII-derived signals (exact age, income estimates) compute with real inputs but only derived
  values are persisted.

---

## 2. Why it lives where it does (design forces)

- **The profile the TS layer sees is categorized and PII-stripped.** `strip_secure` drops the `pii`
  section (PAN / DOB / age). A pure `.ts` port after fetch could NOT compute the ~14 Tier-1 +
  ~10 Tier-2 age/PAN/address signals. => compute server-side where PII still lives.
- **An engine already existed end to end.** `user_story/signals.py` -> `UserStoryStore`
  (L1 cache + L2 Mongo) -> `/internal/user-story/{id}` -> `steps/user-story.ts`. So this work is
  an **UPGRADE + REUSE of the existing path**, not a parallel one.
- **Confirmed decisions:** compute in the sidecar; cache the full tier1+tier2; expose exact age +
  income estimates + raw score to the agent (a scoped relaxation of the "PII-safe only at rest"
  contract); TS-side tracing for now (the sidecar has no OTel exporter yet).

---

## 3. File anatomy (`engine.py`)

Four blocks, top to bottom:

1. **Helpers + config load** (lines 20-55)
   - `safe(v, default=0)`: None-coalescing so arithmetic never trips over missing keys.
   - `parse_institute_counts(inst)`: parses `"CP0-NB2-HF0-PB8-FRB0-OT0"` into a prefix->count dict.
   - Loads `config/scrub_mapping.yaml` once at import into `_CFG` (drives the flat-view adapter).
2. **`compute_tier1(u)`** (lines 63-355): 62 base derived variables from a FLAT scrub-row dict `u`.
3. **`compute_tier2(u, t1)`** (lines 363-655): 34 composite signals built on `u` + Tier-1 outputs.
4. **Compose layer** (lines 662-834): trust gating, severity ranking, human labels.
5. **Flat-view adapter + entry point** (lines 842-924): `_to_flat(doc)` and `run_engine(doc)`.

---

## 4. Tier-1: 62 base derived variables (`compute_tier1`)

- **Reads** a flat dict `u` keyed like the raw Snowflake row (`HL_ALL`, `SCORE`, `<30DPD_12mon`).
- **Verbatim** from `engine_full.py`: the logic is copied unchanged; parity is guaranteed by
  construction and pinned by the parity test.
- Grouped by the reference's B-blocks:
  - **B1 Identity/PAN**: `PAN_HOLDER_TYPE` (4th PAN char -> entity type), `IS_BUSINESS_LINKED_PAN`,
    `PAN_NAME_CONSISTENCY`, `HAS_HUF_PAN`, `KYC_DOCUMENT_DEPTH`, `PASSPORT_FLAG`, `DL_FLAG`,
    `PHONE_REACHABILITY_COUNT`.
  - **B3 Geo**: `RESIDENCE_OWNERSHIP_PROXY`, `ADDRESS_STABILITY_MONTHS`, `ADDRESS_CHANGE_FLAG`,
    `MULTI_PROPERTY_FLAG`.
  - **B4 Demo**: `AGE_EXACT` (from DOB), `GENERATION_COHORT` (GenZ/Millennial/GenX/Boomer+),
    `BIRTHDAY_MONTH`.
  - **B5 Income (implied, informational only)**: `INCOME_FROM_HL`, `INCOME_FROM_CARD_LIMIT`,
    `INCOME_FROM_CAR` via a shared `emi()` reverse-affordability calc.
  - **B6 Self-employed**: `TURNOVER_ESTIMATE_FROM_BL`, `LAP_IS_BUSINESS_FLAG`, `INCOME_FROM_LAP`.
  - **B7 Wealth**: `SECURED_ASSET_WEALTH`, `PROPERTY_VALUE_ESTIMATE`, `EQUITY_INVESTOR_FLAG`,
    `PORTFOLIO_SIZE_PROXY`, `GOLD_FLAG`, `LIFETIME_CREDIT_ABSORBED`, `PREMIUM_CARD_FLAG`.
  - **B9 Behavioral**: `CREDIT_HUNGER_FLAG`, `ENQUIRY_VELOCITY_RATIO`, `IN_MARKET_AUTO/HOME/
    BUSINESS_CREDIT`, `SMALL_TICKET_CHURN_FLAG`, `PRODUCT_DORMANCY_FLAG`.
  - **B10 Lender mix**: `FOREIGN_BANK_FLAG`, `COOPERATIVE_FLAG` (from parsed institute counts).
  - **B11 Repayment**: `RATE_PREMIUM_VS_BENCHMARK`.
  - **B13 Structure/Risk/Reach**: file depth (`BUREAU_VINTAGE_YEARS`, `NTC_THIN_FILE_FLAG`,
    `PAYDOWN_RATIO`, `CLOSED_LOAN_RATIO`), risk (`WORST_DPD_BUCKET_12MON`, `DPD_SEVERITY_INDEX`,
    `ACTIVE_DEFAULT_FLAG`, `SCORE_BAND`, `EMI_BURDEN_BAND`, `CREDIT_DETERIORATION_FLAG`), and reach
    (`MOBILE_IS_PRIMARY_PHONE`, `NAME_TOKEN_COUNT`, `INTRA_CITY_MOVE_FLAG`).
  - **B14 Unsecured**: `ACTIVE_UNSECURED_TRADELINE_COUNT`, `UNSECURED_OUTSTANDING_AMOUNT`,
    `HAS_ACTIVE_EMI_FLAG`, `LONG_TENURE_SECURED_FLAG`.
- **Null discipline:** signals whose inputs are absent return `None` (not 0), so downstream can tell
  "clean" from "unknown" (e.g. `KYC_DOCUMENT_DEPTH` is `None` when PASSPORT/VOTER columns are absent).

---

## 5. Tier-2: 34 composite signals (`compute_tier2`)

- **Reads** the same flat `u` PLUS the Tier-1 output `t1` (so it composes on already-derived values).
- Also **verbatim** from `engine_full.py`, grouped by intent theme:
  - **Lending**: `THICK_MEDIUM_THIN_FILE` (1/2/3, `-999999` when unscored), `UNSECURED_HEADROOM_FLAG`,
    `CREDIT_APPETITE_RISING`, `SECURED_CROSS_SELL_FLAG`, `HOME_LOAN_WHITESPACE`, `CARD_LED_NO_PL`,
    `PRE_DELINQUENCY_WATCH`, `REFI_RATE_SENSITIVE`.
  - **Affluence**: `AFFLUENCE_TIER` (Mass/Mass-Affluent/Affluent/HNI via a points model),
    `PRIVATE_BANKING_FLAG`, `INVESTOR_FLAG`, `LUXURY_VEHICLE_FLAG`, `SECOND_HOME_FLAG`,
    `DISCRETIONARY_SURPLUS_FLAG`, `GLOBAL_MOBILITY_FLAG`.
  - **Income acceleration**: `LENDER_GRADUATION_FLAG`, `RAPID_LIMIT_GROWTH_PROXY`,
    `TICKET_UPSIZING_FLAG`, `YOUNG_PRIME_RISER`, `ASSET_ENTRY_FLAG`.
  - **Aspiration**: `ASPIRATIONAL_YOUNG_FLAG`, `EMI_LIFESTYLE_FLAG`, `FIRST_CARD_RECENT_FLAG`,
    `CONSUMER_DURABLE_INTENT`, `UPGRADE_SEEKER_AUTO`.
  - **Healthcare intent**: `HEALTH_COVER_GAP_FLAG`, `FAMILY_FORMATION_FLAG`, `ELDERCARE_STAGE_FLAG`,
    `MEDICAL_FINANCE_PROXY`.
  - **Savings / investment intent**: `SAVINGS_CAPACITY_FLAG`, `UNDERINVESTED_AFFLUENT_FLAG`,
    `DEBT_LIGHT_PRIME_FLAG`, `BANK_DEPOSIT_RELATIONSHIP`, `ACTIVE_INVESTOR_FLAG`.
- **Age-gated signals** short-circuit to `None` when `AGE_EXACT` is `None` (age is a required input).

---

## 6. Compose layer: gating, severity, labels (`build_compose`)

Turns the raw Tier-2 dict into a small, ranked, human-readable list the agent can surface directly.
Three static tables + a builder:

- **`TRUST_STATUS`**: each Tier-2 var tagged `reliable` / `needs_retest` / `not_computable`.
- **`SEVERITY`**: each var tagged `risk_high` / `risk_medium` / `opportunity` / `info` / `context`.
- **`SEVERITY_RANK`**: sort order (risk_high=0 first ... context=4 last).
- **`BINARY_FLAGS`**: the set of vars that only matter when they fire (value == 1).
- **`LABELS`**: a per-var lambda mapping the value to a `(label, verdict)` human pair, e.g.
  `HOME_LOAN_WHITESPACE -> ("Home loan eligibility", "eligible, none taken")`.

`build_compose(t2, allow_needs_retest=False)` filters then ranks:

1. Drop `None` values.
2. Drop `not_computable`, and drop `needs_retest` unless explicitly allowed.
3. Drop binary flags that did not fire (value != 1).
4. Drop the default `AFFLUENCE_TIER == "Mass"` (no signal).
5. Sort survivors by severity rank.
6. Emit one dict per survivor: `{var, value, label, verdict, severity, trust_status}`.

Net effect: `compose` is the "show me what matters, worst-first" view; tier1/tier2 are the full raw
substrate behind it.

---

## 7. The flat-view adapter (`_to_flat`): the crux of the port

- **Problem:** the ported functions read a FLAT Snowflake-style row (`HL_ALL`, `<30DPD_12mon`), but
  at runtime we hold the **categorized** doc (the normalizer's output, as stored in Mongo/Redis).
- **Solution:** `_to_flat(doc, cfg=_CFG)` is the **deterministic inverse of `scrub_mapping.yaml`**;
  it rebuilds the flat keys from the categorized sections before the engine runs.
- Section-type handling:
  - `scalar`: map each categorized field back to its column; single-element list cols unwrap.
  - `product`: for each product block (`HL`, `PL`, `totals`->`Total`), expand metrics into
    `{PRODUCT}_{SUFFIX}` keys.
  - `institution`: emit `{PRODUCT}_{SUFFIX}` from the raw institute string.
  - `dpd`: rebuild bucket/month keys, **keeping the reference's mixed case** (`<30DPD_12mon`).
- **Key-case contract** (matches the raw Snowflake row):
  - Financial / scalar / institution keys are **UPPERCASED** (`HL_ALL`, `SCORE`).
  - DPD keys keep the reference's mixed case (`<30DPD_12mon`), NOT uppercased.
- **Lossy-list guard:** the normalizer drops `None` entries from PII lists (phones, addresses), so
  positions are lost when a list is shorter than expected. `_to_flat` only reconstructs those keys
  when the stored list is full-length; otherwise the geo/reach signals degrade to `None` rather than
  being reconstructed wrong.

---

## 8. Entry point (`run_engine`)

```python
def run_engine(doc):
    u = _to_flat(doc)                 # categorized -> flat scrub-row
    t1 = compute_tier1(u)             # 62 base variables
    t2 = compute_tier2(u, t1)         # 34 composite signals
    return {"tier1": t1, "tier2": t2, "compose": build_compose(t2)}
```

- **Must be called at materialize time**, when `doc` still carries `pii` (PAN / DOB / age): that is
  the only moment the PII-derived Tier-1 signals compute with real inputs.
- Output is **derived values only**; no PAN / DOB / raw address ever leaves the function.

---

## 9. Parity guarantee (how we know the port is correct)

- Test: [tests/unit/test_signal_engine.py](../../tests/unit/test_signal_engine.py), run over the real
  100-user sample.
- Every mapped Tier-1 signal + all Tier-2 signals **match `engine_full.py` exactly**.
- Known, documented divergences (all caused by columns the normalizer drops, NOT logic bugs):
  `GLOBAL_MOBILITY_FLAG`, `PASSPORT_FLAG`, `KYC_DEPTH`, `DL_FLAG`, `PHONE_REACHABILITY_COUNT`, and
  address geo: PASSPORT / VOTER / DL / MOBILE columns and lossy PII lists are not present in the
  categorized doc.
- The test **skips gracefully** when `engine_full.py` is absent (it is a local parity oracle, not a
  committed dependency), so CI does not depend on the reference file.

---

## 10. How it is wired into the flow (end to end)

### 10.1 Write path (compute + persist, OFF the request hot path)

- `bureau/resolver.py :: resolve()` builds/refreshes the profile from L1 (redis) / L2 (mongo) /
  L3 (Snowflake). On any **rebuild** it calls `_materialize_story(user_id, doc)` (at both the Mongo
  and Snowflake branches), while `doc` still holds PII.
- `_materialize_story` is **best-effort / fail-soft**: a story-store failure logs a warning
  (traceback only, never the doc or user_id) and never breaks bureau serving.
- `UserStoryStore.materialize(user_id, doc)` ([store.py](../../src/nodes/raw_data/user_story/store.py)):
  - Calls `compute_signals(doc)` = structural rubric + `run_engine(doc)`.
  - Times the compute and stamps `signals._meta.compute_ms`.
  - Writes **L2 Mongo first, then L1 cache** (`cc:story:{id}`, TTL 24 h), so a crash cannot leave
    only the cache populated.
- `signals.py :: compute_signals` returns `{**_structural_signals(doc), **run_engine(doc)}`;
  the structural keys (`segment`, `file_tier`, `life_stage`, intent flags read by `classify` and the
  persona rubric) stay top-level for back-compat; the rich set nests under `tier1`/`tier2`/`compose`.
  `SIGNALS_VERSION` was bumped 1 -> 2 so a schema change forces re-materialization.

### 10.2 Serve path (Python API)

- `GET /internal/user-story/{user_id}` in
  [bureau_internal.py](../../src/nodes/api/routes/bureau_internal.py):
  - Normalizes the mobile -> user_id, reads `UserStoreStore.get()` (L1 -> L2 read-through, re-warms
    L1 on an L2 hit).
  - Returns `strip_secure(story)` as defense-in-depth (never return a secure section even if one
    leaked into the persona; `materialize` asserts PII-safety but does not enforce it).
  - 404 when no story, 503 when the store is not configured, 400 on a malformed mobile.

### 10.3 Fetch path (TypeScript / Mastra)

- [lib/user-story-fetch.ts](../../src/mastra/lib/user-story-fetch.ts): the single source of truth for
  calling the sidecar, mirroring `lib/bureau-fetch.ts`:
  - In-process TTL cache (`USER_STORY_CACHE_TTL_MS`, default 15 min; `CACHE_MAX` bounds memory) so a
    multi-turn conversation fetches once and reuses.
  - Wraps every call in a `user-story.fetch` span: records `app.story.result` (ok / not_found /
    error / unreachable), `app.story.cache` (hit / miss), `app.story.http_status`, and
    `app.story.compute_ms` (passed through from the payload). **PII-safe attrs only**: never the
    user_id, URL, or raw signal values.
  - Returns a discriminated result; only `ok` payloads are cached (misses/errors retry next turn).
  - `peekUserStory(user_id)` reads the cache without fetching (used by the pull tool).

### 10.4 Threading into the workflow

- [server.ts](../../src/mastra/server.ts) fetches the story **once per request** alongside the
  profile (`fetchUserStory(user_id)`), and threads `signals` into the workflow `initData`. Enrichment
  only: a miss/error is non-fatal, so the specialist still runs on the masked profile.
- [credix-workflow.ts](../../src/mastra/workflows/credix-workflow.ts) declares `signals` as an
  optional field on `initData` and passes it to `makeAgentStep`.

### 10.5 Agent access: two paths

- **PUSH (every turn, no tool round-trip):** `makeAgentStep` calls
  [buildSignalSummary](../../src/mastra/lib/signal-summary.ts) and injects a compact, **PII-safe**
  headline (segment | file tier | life stage, then the top 3 gated compose bullets) into the
  specialist's prompt. Exact age and income are **NOT** spelled here: they stay tool-pullable.
- **PULL (on demand):** the [getSignals](../../src/mastra/tools/signals.ts) tool (attached to all 4
  specialists: credix, credit-card, insurance, score-improvement) reads the in-process cache
  (falls back to a fetch on a miss), with optional section narrowing:
  - `section: 'tier1'` -> 62 base vars incl. **exact age + income estimates**;
  - `section: 'tier2'` -> 34 composite signals;
  - `section: 'compose'` -> the ready-to-surface ranked list;
  - omitted -> the whole payload.
  - Emits a `signals.lookup` span with PII-safe attrs only (presence, `compose_count`,
    `affluence_tier`, `file_tier`, never exact age / raw score / income numbers).

---

## 11. PII contract (exact boundaries)

- **At rest:** the persona store and the TS module cache MAY carry exact age + income estimates +
  raw score (the approved relaxation). Everything else stays derived/flags-only.
- **Never:** exact age, raw score, or income numbers may reach a **trace span** or a **log**. Spans
  carry only counts, coarse tiers, and result enums.
- **Push summary** is prompt-safe (no spelled numbers); **pull tool** is the only way exact numbers
  reach the model, and only into the prompt/generation, never observability.
- The Python serve route double-strips with `strip_secure` as belt-and-suspenders.

---

## 12. Verification status (as shipped 2026-07-09)

- `ruff format` + `ruff check` clean on `src/`.
- `pytest`: 81 passed / 9 skipped (parity test included, skips without the local oracle).
- `bun test`: 210 pass / 0 fail / 14 skip, incl. the E2E proof
  ([signals-e2e.test.ts](../../src/mastra/__tests__/signals-e2e.test.ts)): real `/v1/chat` ->
  mocked sidecar -> workflow, asserting the specialist prompt carries the summary (push) AND
  `getSignals` reads exact age 41 from the warm cache after the request (pull).
- `tsc --noEmit` clean.

---

## 13. Known follow-ups (out of scope here)

- Python sidecar OTel + `traceparent` propagation for a real `signals.compute` span (today the cost
  rides in `compute_ms`, surfaced by the TS `user-story.fetch` span).
- LLM prose `user_story` render: `store.materialize` leaves `user_story = None`;
  [steps/user-story.ts](../../src/mastra/steps/user-story.ts) is still the stub for this.
- Add PASSPORT / VOTER / DL to `scrub_mapping.yaml` if those KYC-depth signals are wanted.
- Root `engine_full.py` is now redundant in production; kept only as the parity oracle for the test.
