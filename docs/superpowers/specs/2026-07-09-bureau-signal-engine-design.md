# Design: bureau signal engine, module cache, and agent access

Date: 2026-07-09
Status: proposed (awaiting review)
Author: session (feat/bureau-python-wrapper)
Source request: port `engine_full.py` as a layer after bureau fetch, compute the signals,
store them in a module level cache the agent can read, and make the computation observable.

## 1. Context

`engine_full.py` (repo root) is a standalone script: 62 Tier-1 base derived variables,
34 Tier-2 composite signals, and a compose facing layer (`TRUST_STATUS`, `SEVERITY`,
`LABELS`, `get_compose_signals`). It reads a FLAT Snowflake scrub row (`u.get("HL_ALL")`,
`u.get("SCORE")`) and is wired into nothing.

The live runtime is the TypeScript Mastra service (`src/mastra/`, Honeycomb service
`credix-mastra`). Bureau data is fetched once per request in Hono
([server.ts:94](../../../src/mastra/server.ts)) via `fetchBureau`, which returns a
PII stripped, CATEGORIZED profile (`general_info.score`, `loan_details.HL.all`,
`dpd.buckets.lt30.m12`) produced by the sidecar normalizer
([normalizer.py](../../../src/nodes/raw_data/bureau/normalizer.py) +
[config/scrub_mapping.yaml](../../../config/scrub_mapping.yaml)).

Two constraints shaped this design and are the reason it is NOT a straight `.ts` port:

1. PII stripping. `/internal/bureau/{id}` runs `strip_secure(doc)`, dropping the whole
   `pii` section (PAN, DOB, name, phones, addresses; `secure: true` in scrub_mapping).
   The TS runtime never sees those fields, so a `.ts` engine could not compute the
   ~14 Tier-1 and ~10 Tier-2 signals that depend on age / PAN / address.
2. An engine already exists. The persona layer already runs the exact
   compute-at-fetch to PII-safe-store to serve to consume loop, with a smaller signal
   set:
   - engine: [`user_story/signals.py`](../../../src/nodes/raw_data/user_story/signals.py)
     `compute_signals(doc)` (~20 signals), reads the CATEGORIZED doc incl. `pii.age`.
   - compute point: resolver `_materialize_story`
     ([resolver.py:73](../../../src/nodes/raw_data/bureau/resolver.py)), off the hot path,
     where the doc still carries PII.
   - store: `UserStoryStore` L1 cache (`cc:story:{id}`) + L2 Mongo, versioned, PII-safe.
   - endpoint: `/internal/user-story/{id}`.
   - TS consumer: [`steps/user-story.ts`](../../../src/mastra/steps/user-story.ts), a stub.

`engine_full.py` is the richer successor to `user_story/signals.py`. The production move is
to upgrade the existing engine and reuse the existing plumbing, not to build a parallel path.

## 2. Goals / non-goals

Goals
- Compute the full 62 + 34 signal set for every user, correctly (with PII inputs present).
- Make the signals easy for the specialist agents to read: a module level cache plus a tool.
- Make the computation and access observable in Honeycomb without leaking PII.
- Reuse the existing persona plumbing (materialize, store, endpoint) rather than duplicating it.

Non-goals
- Standing up OpenTelemetry in the Python sidecar (tracked as a follow-up, see section 8).
- LLM prose rendering of the user story (`user_story` stays `None`, a separate deferred task).
- Changing the categorized bureau profile shape TS receives (unchanged; nothing goes flat).
- Population level signals (`HIGH_ATS_FLAG`) that need a P80 baseline (stay `None`, as today).

## 3. Decisions (confirmed with requester)

- D1 Compute location: Python sidecar, at materialize time, reusing `_materialize_story`.
- D2 Payload: full Tier-1 + Tier-2 plus a gated `compose` list.
- D3 Sensitive values to the agent: exact `AGE_EXACT`, income estimates, and the raw score
  are exposed to the agent. This RELAXES the persona store's "PII-safe only at rest"
  contract for exact age specifically. Scope of the relaxation: exact age may live in the
  signal payload (persona store L1/L2 and the TS module cache) but must NEVER appear on a
  trace span or in any log. Raw score already sits at rest in the bureau cache; income
  estimates are derived, not raw PII.
- D4 Tracing: TS side spans now (Honeycomb already works there); sidecar OTEL is a follow-up.
- D5 Input shape: the upgraded engine reads the CATEGORIZED doc (matching the existing
  `compute_signals` convention), NOT the flat row. There is a working reference for every
  access pattern in the current file.

## 4. Architecture

```
Snowflake flat row
   -> normalizer.transform(flat)            -> categorized doc  (UNCHANGED shape)
   -> resolver._materialize_story(doc)
        -> compute_signals(doc)             [UPGRADED: full engine, reads categorized doc]
        -> UserStoryStore.materialize       [UNCHANGED plumbing; stores {tier1,tier2,compose}]
             -> L1 cache cc:story:{id}  +  L2 Mongo   (versioned, now incl. exact age per D3)

/internal/user-story/{id}                    [UNCHANGED route; serves the story payload]

TS runtime (credix-mastra):
   server.ts  -> fetchBureau (existing)
              -> fetchUserStory(user_id)     [NEW lib, mirrors bureau-fetch: in-proc TTL cache
                                              + `user-story.fetch` span; module level cache]
              -> initData.signals
   steps/user-story.ts                        [IMPLEMENT stub: build persona summary for
                                              specialist system prompts from initData.signals]
   tools/signals.ts (getSignals)             [NEW tool: reads the module cache; `signals.lookup`
                                              span; wired into specialist agents like getStatement]
```

## 5. Component specifications

### 5.1 `src/nodes/raw_data/user_story/signals.py` (upgrade)

Replace the body of `compute_signals(doc)` with the ported `engine_full.py` logic, adapted
to read categorized paths. Output contract:

```python
{
  "tier1": { ...62 base vars... },     # incl. AGE_EXACT (exact), income estimates, SCORE_BAND
  "tier2": { ...34 composites... },
  "compose": [                         # trust-gated, severity-ranked, structured (not a string)
    {"var","value","label","verdict","severity","trust_status"}, ...
  ],
  # backward-compat structural surface derived from tier1/tier2 so classify() keeps working:
  "segment","file_years","file_tier","life_stage","dpd_health",
  "has_loan_history","products","income_reliable",
}
```

Porting rules (flat key -> categorized path), driven by scrub_mapping.yaml:
- `SCORE`,`FOIR`,`SALARY`,`DT`,`AVG_ACC_AGE`,`CREDIT_HISTORY_LENGTH`,`EXISTING_EMI`
  -> `general_info.{score,foir,salary,dt,avg_acc_age,credit_history_length,existing_emi}`
- `<P>_<METRIC>` (e.g. `HL_ALL`,`HL_MAX`,`CC_MAX_CREDITLIMIT`,`CC_UTILIZATION_PCT`)
  -> `loan_details.<P>.<metric>` (`all,active,outstanding,disbursed_all,disbursed_active,max,
     ats,recency`; CC extras `utilization_pct,max_creditlimit`); `TOTAL_*` -> `loan_details.totals.*`
- `<P>_ENQ_30D/90D`,`TOTAL_ENQ_*` -> `enquiries.<P|totals>.{enq,enq_30d,enq_60d,enq_90d,...}`
- `PL_HIGHEST_INTEREST_RATE` -> `loan_repayments.PL.highest_interest_rate`
- `*_6MON_LT_10K` -> `borrowing_window.<P>.m6_lt`; `*_12MON_*` -> `.m12_lt`
- `TOTAL_INSTITUTE` -> `institution_details.totals.raw` (parse into counts via `.parsed`)
- DPD `<30DPD_12mon`,`30-60DPD_3mon`,`90+_DPD_12mon`
  -> `dpd.buckets.{lt30,30_60,60_90,90_plus}.{m1,m2,m3,m6,m12}`; PL DPD -> `dpd.PL.*`
- PII inputs `PAN`,`DOB`,`APPLICANT_NAME`,`PHONE_*`,`ADDRESS_*`
  -> `pii.{pan,dob,name,phones[],address_1[],address_2[]}` (present at materialize time)
- Not in scrub_mapping (`PASSPORT`,`VOTER`,`DL`): stay `None`, exactly as engine_full already
  guards (KYC depth, passport flag).

`compute_tier1` / `compute_tier2` / the compose maps (`TRUST_STATUS`, `SEVERITY`, `LABELS`)
and the gating logic of `get_compose_signals` port over unchanged in spirit; only field
access changes. Every access stays defensive (`.get`) because the normalizer drops all-null
product blocks. Bump `SIGNALS_VERSION` from 1 to 2 so stored docs re-materialize.

`classify(signals)` keeps its current signature and reads the backward-compat structural keys.

### 5.2 Sidecar plumbing (no change)

`UserStoryStore.materialize` already does `{"signals": compute_signals(doc), ...}` and stores
to L1 + L2; it is shape agnostic. `_materialize_story` already runs it fail-soft on every
rebuild. `/internal/user-story/{id}` already serves it through `strip_secure`. Per D3, the
payload now carries exact age; `strip_secure` only drops declared `secure` sections, so the
signal payload is served intact (it is not a bureau section).

### 5.3 `src/mastra/lib/user-story-fetch.ts` (new, mirrors `bureau-fetch.ts`)

```ts
export type UserStoryResult =
  | { ok: true; signals: Record<string, unknown> }
  | { ok: false; notFound: true }
  | { ok: false; status: number }

export async function fetchUserStory(user_id: string): Promise<UserStoryResult>
export function clearUserStoryCache(): void   // test hook
```

- In-process `Map<user_id, {signals, expiresAt}>` with `USER_STORY_CACHE_TTL_MS`
  (default 900_000) and `CACHE_MAX` bound + oldest eviction, copied from bureau-fetch.
- `user-story.fetch` span. PII-safe attrs only:
  `app.story.result` (ok|not_found|error|unreachable), `app.story.cache` (hit|miss),
  `app.story.http_status`, `app.story.compute_ms` (from `signals._meta.compute_ms` if the
  sidecar stamps it; see 5.6). NEVER age / score / any raw value.
- Only `ok` is cached; not_found / error re-try next turn (same rule as bureau-fetch).

### 5.4 `src/mastra/server.ts` (wire the fetch)

After the existing `fetchBureau` block, call `fetchUserStory(user_id)`. On `ok`, add
`signals` to the workflow `inputData` alongside `bureau_profile`. A not_found / error is
non-fatal: signals are an enrichment, so log-free-degrade and pass `signals: undefined`
(the specialist still runs on the masked profile). No new PII on the HTTP span.

### 5.5 `src/mastra/steps/user-story.ts` (implement the stub)

Reads `getInitData().signals`. Produces a compact, PII-safe persona summary string for
injection into specialist system prompts (segment, file_tier, life_stage, top compose
bullets). This is the "push" path. Prose `user_story` via LLM stays deferred (out of scope).

### 5.6 `src/mastra/tools/signals.ts` (new tool, the "pull" path)

`getSignals({ user_id })` reads the module cache populated by `fetchUserStory` (falls back
to a fetch on a miss). Returns the full `{tier1, tier2, compose}` payload so a specialist can
pull exact age, income estimates, raw score, and any flag on demand. `signals.lookup` span
with PII-safe attrs (`app.signals.present`, `app.signals.compose_count`,
`app.signals.affluence_tier`, `app.signals.file_tier`). Wired into the specialist agents
(credix, score-improvement, credit-card) exactly like `getStatement`.

Optional sidecar stamp for observability: `_materialize_story` records wall-clock compute
time into `signals["_meta"]["compute_ms"]`. This is the only new sidecar-side change beyond
the engine; it lets `user-story.fetch` surface compute cost without Python OTEL.

## 6. Data flow (per request)

1. Hono `/v1/chat`: `fetchBureau` (existing) then `fetchUserStory` (new), both in-proc cached.
2. Workflow runs with `inputData.bureau_profile` and `inputData.signals`.
3. `user-story` step builds the persona summary; specialists receive it in their prompt.
4. A specialist may call `getSignals` to pull the full set (exact age / score / income / flags).
5. Compose / post-guardrail unchanged.

## 7. PII and security

- Engine OUTPUT contains only derived values, never raw PAN / Aadhaar / mobile / name /
  address strings. Exact age is the one raw quasi-identifier and is exposed per D3.
- Trace spans carry counts, tiers, and result enums only. Exact age, raw score, income
  numbers, and hard identifiers never touch a span attribute (otel.ts rule holds).
- `maskProfilePii` (pre-guardrail) is unaffected: signals reach the LLM ONLY via the tool /
  the user-story summary, never smuggled through `masked_profile`.
- L1 (Pogocache) and L2 (Mongo) now hold exact age inside the story payload. Documented as a
  deliberate relaxation (D3); the story store docstring and cc:story key comment get updated.

## 8. Tracing (Honeycomb)

Delivered now (TS side, service credix-mastra):
- `user-story.fetch` span (fetch + cache outcome, `compute_ms` passthrough).
- `signals.lookup` span inside `getSignals`.
- Both nest under the existing `credix.workflow` span, so signal compute cost and agent
  access are queryable next to `bureau.fetch` and `agent.generate`.

Follow-up (not blocking): OpenTelemetry SDK + OTLP exporter in the FastAPI sidecar, plus
`traceparent` propagation from `bureau-fetch`/`user-story-fetch`, so a real `signals.compute`
span nests in the same distributed trace. Larger infra change; tracked separately.

## 9. Error handling

- Sidecar down / 404 for user-story: non-fatal, signals `undefined`, specialists still run.
- Corrupt / partial payload: treated as absent (mirrors statement-store), never thrown at
  the agent.
- Materialize failure in the sidecar: already fail-soft (`_materialize_story` swallows and
  logs without PII). Bureau resolution never breaks because signals failed.
- Version skew: `SIGNALS_VERSION` bump forces re-materialization; a stale-shaped stored
  payload is re-computed rather than served.

## 10. Testing

Python
- `tests/unit/test_user_story_signals.py`: update to the new output shape; keep the
  segment / income_reliable / DEMAND_COOLED / classify assertions against the compat surface.
- New cases: a full categorized doc (from `normalizer.transform` on a sample flat row)
  computes tier1 + tier2 without raising; compose gating drops not_computable / needs_retest /
  unfired flags; exact age present in tier1; PII-derived signals populated when `pii` present
  and `None` when absent.
- Parity check: port `engine_full.py`'s `__main__` sample expectation into a test so the
  ported logic matches the reference for a known user.

TypeScript
- `user-story-fetch` unit tests mirroring `bureau-fetch` (TTL, eviction, ok/not_found/error,
  cache hit path, no PII on span).
- `getSignals` tool test (module-cache hit, miss-then-fetch fallback, output shape).
- Extend `steps.test.ts` for the user-story step producing a summary from init signals.

Gates: `ruff format` + `ruff check --fix`; `bun test`; `npx tsc --noEmit`; verify skill green
before commit.

## 11. Config / rollout

- Sidecar URL + auth reuse the existing `BUREAU_SIDECAR_URL` + `INTERNAL_API_SECRET` (no new endpoint host).
- `USER_STORY_CACHE_TTL_MS` (default 900_000), `USER_STORY_CACHE_MAX` (default 1000).
- `SIGNALS_VERSION` 1 -> 2 triggers a one-time re-materialization on next access per user.
- Ship behind the existing pipeline; no new infra. Rollback = revert the engine upgrade and
  the version bump (stored docs re-materialize back to v1 shape).

## 12. Risks

- Porting 96 field accesses from flat to categorized is mechanical but error-prone; mitigated
  by the parity test and the existing reference access patterns.
- Exposing exact age broadens PII at rest; mitigated by scoping (never on spans/logs) and by
  explicit documentation of the relaxation.
- Second sidecar call per cold request; mitigated by L1 (cc:story) + in-proc TTL cache (warm
  turns are ~0 cost, same profile as bureau-fetch).

## 13. Follow-ups (out of scope)

- Python sidecar OpenTelemetry + distributed trace propagation.
- LLM prose `user_story` render.
- Population-baseline signals (`HIGH_ATS_FLAG`) once a P80 baseline exists.
- Retest the `needs_retest` compose flags on a real population sample (see engine TRUST_STATUS).
