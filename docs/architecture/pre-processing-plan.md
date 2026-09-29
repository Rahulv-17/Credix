# Plan — Bureau pre-processing pipeline (Redis → Mongo → Snowflake read-through)

## Context

`staging/` already has the two halves of a bureau-data system but no bridge between them:

- **`snowflake-fetch/`** — a sync CLI (`fetch_bureau_profile.py`) that pulls one user's row as a **flat, UPPERCASE** dict of ~280–320 columns (`SCORE`, `PL_OUTSTANDING`, `<30DPD_1mon`, `PL_INSTITUTE`, …) via `OBJECT_CONSTRUCT(*)` over 9 joined tables. Source of truth, but slow and not agent-friendly.
- **`user-fetch-by-mobile/source/`** — an async **motor** MongoDB layer (`get_db()` → `captain_ai`, reads `MONGODB_URI`/`MONGODB_DB`) plus the canonical identity function `mobile_to_token(mobile) = sha256("91"+mobile)[:32]` used as `user_token` across existing collections.

The goal is the read-through the design describes: **given a mobile, serve from Redis (L1) → Mongo (L2) → Snowflake (L3)**; on a miss, fetch from Snowflake, normalize the flat row into a categorized JSON document (sections mirror the 9 tables, products nested inside), then enrich **both** Mongo (`bureau_data` collection, full doc incl. PII, immutable per scrub-month) and Redis (`cc:profile:{token}`, PII stripped, TTL'd) in the same structure. This makes the credit data both auditable and cheap for an agent to slice via JSONPath (`$.loan_details.PL`).

This plan builds that pipeline in `pre-processing/`, wires a **global `staging/.env`**, and stands up **Redis (RedisJSON) in Docker** as the one new infra dependency.

### Confirmed decisions
- **Token:** ~~reuse `mobile_to_token` — `sha256("91"+mobile)[:32]`~~ — **SUPERSEDED (2026-06-09):** the canonical user key is now the **bare 10-digit mobile** (`mobile_to_user_id`), used as `user_id` in the JSON, `_id="{user_id}:{scrub_month}"` in Mongo, and `cc:profile:{user_id}` in Redis. The `captain_ai`/`user_token` join is out of scope. A 15-day Mongo freshness window (`BUREAU_FRESH_DAYS`) was added so returning users are served from Mongo without re-hitting Snowflake. See the dedicated plan and the README "Identity & freshness" section.
- **Client:** sync `pymongo` + sync `redis-py` resolver (consistent with the sync Snowflake CLI). pymongo 4.17 already in `.sfcli`.
- **Redis:** in scope now, via `redis/redis-stack-server` (RedisJSON bundled).
- **Mongo:** **Atlas cloud** via the provided `MONGODB_URI` (effective DB `captain_ai`, collection `bureau_data`). Compose is **Redis-only** — *assumption; flag if a local dockerized Mongo is wanted instead.*

## Validated against real data
- Sample JSONs (`snowflake-fetch/user_9944003361.json`) confirm a **flat dict, UPPERCASE keys**. The design's `_index()` uppercases every key, so its mixed-case YAML candidates (`PL_outstanding`, `ATS`, `1mon`) resolve correctly. The `{PRODUCT}_{metric}` split and DPD prefixes (`<30DPD`, `30-60DPD`, `60-90DPD`, `90+_DPD`) match actual columns.
- The xlsx spec has a known typo (`PL_institute` row mapped to `CC_institute`); irrelevant because the normalizer reads SF columns directly. Some columns (`*_HIGHEST_INTEREST_RATE`, `*_AVERAGE_GAP`) are absent for sparse users — the normalizer already drops all-null product blocks, so this is handled.

## Files & layout

New package under `pre-processing/`:

```
pre-processing/
  PLAN.md                     # this plan, project-facing copy (user asked for it here)
  README.md                   # run instructions
  docker-compose.yml          # redis/redis-stack-server only (Mongo = Atlas)
  requirements.txt            # pyyaml, redis  (motor/pymongo/snowflake already in .sfcli)
  config/
    scrub_mapping.yaml        # the declarative section/metric map from the design
  pipeline/
    __init__.py
    identity.py               # re-exports mobile_to_token (single source of truth)
    normalizer.py             # Normalizer (YAML-driven) — from design, tokenize→mobile_to_token
    repositories.py           # MongoRepo (pymongo) + RedisRepo (redis-py, JSON.* via execute_command)
    snowflake_source.py       # fetch_scrub_row(mobile)->flat dict, extracted from fetch_bureau_profile
    resolver.py               # ProfileResolver: Redis→Mongo→Snowflake + stampede lock
    env.py                    # shared loader: load staging/.env (global) + local .env
  resolve.py                  # CLI: python resolve.py <mobile> [--path $.loan_details.PL]
```

### Reuse (do not reinvent)
- `mobile_to_token` — [user-fetch-by-mobile/source/token.py](user-fetch-by-mobile/source/token.py). `pipeline/identity.py` imports/re-exports it; a unit assertion pins output equality so the token never silently diverges.
- Snowflake connect + `SQL_BY_MOBILE` query logic — [snowflake-fetch/fetch_bureau_profile.py](snowflake-fetch/fetch_bureau_profile.py). Extract its connect/query-by-mobile into `snowflake_source.fetch_scrub_row(mobile)`; the existing CLI keeps working by calling the same function.
- The minimal `.env` loader pattern (no dependency, "existing env wins") — [fetch_bureau_profile.py:40-58](snowflake-fetch/fetch_bureau_profile.py#L40-L58). `pipeline/env.py` generalizes it to load **local `.env` first, then `staging/.env`** (first-loaded wins → local overrides global, global fills shared keys).
- Mongo conventions (`MONGODB_URI`/`MONGODB_DB`, DB `captain_ai`) — [source/mongodb.py](user-fetch-by-mobile/source/mongodb.py). Mirror env-var names exactly.

## Implementation steps

1. **Global env.** Create `staging/.env` with `MONGODB_URI`, `MONGODB_DB=captain_ai`, `REDIS_URL=redis://localhost:6379/0`, `REDIS_TTL=86400`. Add `staging/.gitignore` ignoring `.env` (snowflake-fetch already ignores its own). Write `pipeline/env.py` and call it at the top of `resolve.py`, `snowflake_source.py` so every entrypoint sees the global vars.
2. **Docker / Redis.** Add `pre-processing/docker-compose.yml` with `redis/redis-stack-server:latest` (`command: redis-stack-server --save 60 1 --appendonly yes`, healthcheck `redis-cli ping`, volume). `docker compose up -d redis`.
3. **Deps.** `pre-processing/requirements.txt` = `pyyaml`, `redis`; install into the `.sfcli` venv (`.sfcli/bin/pip install -r requirements.txt`).
4. **Identity + normalizer.** `identity.py` (reuse token). `normalizer.py` from the design, but `tokenize` → `mobile_to_token`; keep the YAML-driven `_scalar/_product/_institution/_dpd` dispatch and the `schema_version` field in `_meta`. `config/scrub_mapping.yaml` = the design's mapping verbatim.
5. **Repositories.** `MongoRepo` (pymongo): collection `bureau_data`, `_id = "{token}:{scrub_month}"`, indexes unique `_id` + `{token:1, scrub_month:-1}`, `latest(token)` / `upsert(doc)`. `RedisRepo` (redis-py): `cc:profile:{token}` via `JSON.SET/JSON.GET`, `get_path()` for agent slices, PII stripped on `set()`, `expire(REDIS_TTL)`. On bootstrap, run `MODULE LIST` and fail fast if ReJSON isn't loaded (guards against a plain-redis image).
6. **Snowflake source.** Extract `fetch_scrub_row(mobile)` from the CLI; return the flat OBJECT_CONSTRUCT dict.
7. **Resolver.** `ProfileResolver.resolve(mobile)`: tokenize → Redis L1 → `cc:lock:{token}` SET NX PX stampede guard → double-check Redis → Mongo L2 (`latest`, backfill Redis) → Snowflake L3 (`fetch_scrub_row` → `normalize` → Mongo upsert incl. PII → Redis set PII-stripped). Add the `schema_version` gate on Redis reads (stale shape → treat as miss).
8. **CLI + docs.** `resolve.py <mobile> [--path]`. `README.md` (compose up, env, run). Copy this plan to `pre-processing/PLAN.md`.
9. **Project planning convention.** Per `staging/.claude/rules/planning.md` (3+ steps ⇒ written plan), create `staging/tasks/todo.md` + `findings.md` + `progress.md` with the phases above so session-persistence rules are satisfied.

## Verification (end-to-end)
- **Infra:** `docker compose up -d redis` → `redis-cli ping` returns PONG and `redis-cli MODULE LIST` shows `ReJSON`.
- **Cold path (L3):** `.sfcli/bin/python resolve.py 9944003361` — confirm it hits Snowflake, writes one `bureau_data` doc (`_id = <token>:Oct-2025`), and sets `cc:profile:<token>`. Spot-check the doc shape against `snowflake-fetch/user_9944003361.json` (e.g. `general_info.score == 900`, `loan_details.PL.outstanding`, DPD buckets populated, `pii` present in Mongo but ABSENT from the Redis key).
- **Warm paths:** re-run → served from Redis (L1). `redis-cli DEL cc:profile:<token>` then re-run → served from Mongo (L2), Redis re-populated. Verify token equals `mobile_to_token("9944003361")`.
- **Agent slice:** `resolve.py 9944003361 --path '$.loan_details.PL'` returns just the PL block.
- **Quality gate:** run the `verify` skill (ruff) on new Python before any commit, per `code-quality.md`.

## Out of scope (noted for later)
- FastAPI service + Dockerfile wrapping the resolver (the compose `app` service from the design snippet). Resolver is built as a reusable library + CLI so this is a thin later add.
- Local dockerized Mongo (using Atlas instead).
