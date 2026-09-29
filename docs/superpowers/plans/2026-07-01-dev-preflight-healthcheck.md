# Dev Preflight Healthcheck Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Before `npm run dev` starts the `interface/` UI, probe every credix backend dependency (Hono server, xAI Grok agent LLM, FastAPI sidecar, Pogocache L1, MongoDB L2, Snowflake L3) one by one and print a no-emoji status table; warn-and-continue by default, block with `--strict`.

**Architecture:** The frontend Node process cannot reach Pogocache/Mongo/Snowflake directly (no drivers, no creds). So deep checks live on the backend: the FastAPI sidecar (which already holds all three store clients) exposes `/internal/health/deep`, and the Hono server exposes `/health/deep` for the agent LLM. A dependency-free Node preflight script (`interface/scripts/preflight.mjs`), wired as npm `predev`, calls those endpoints, aggregates the results, and renders the table. Every check is isolated with a timeout so one dead service never masks another, and no endpoint or the script ever throws uncaught.

**Tech Stack:** Python 3.12 / FastAPI + pytest (sidecar); Hono + `bun test` (server); Node ESM (preflight, no new deps). xAI OpenAI-compatible API.

## Global Constraints

- Sidecar auth header is `X-Internal-Token`, compared with `hmac.compare_digest` against `INTERNAL_API_SECRET`; deep-health reuses `verify_internal_token`. (source: `bureau_internal.py`)
- Pogocache client MUST use `protocol=2` (RESP2) or the `HELLO` handshake fails. (memory: pogocache-resp2; `factory.py`)
- Default endpoints: Hono `CREDIX_API_URL=http://localhost:3000`; sidecar `BUREAU_SIDECAR_URL=http://localhost:8000`; cache `REDIS_URL=redis://localhost:9401`; xAI `https://api.x.ai/v1` with `GROK_API_KEY`. (`.env.example`, `provider.ts`)
- No emojis anywhere in output. Table columns: `SERVICE | STATUS | DETAIL`; statuses are exactly `OK` / `DOWN` / `UNKNOWN`. (user request)
- Warn-then-continue: preflight exits 0 even when services are down, so `next dev` still starts; `--strict` (or `PREFLIGHT_STRICT=1`) makes any `DOWN`/`UNKNOWN` exit 1; `SKIP_PREFLIGHT=1` bypasses entirely. (user decision)
- Health endpoints never 500 and never touch PII; each check is time-boxed. (graceful-error-handling requirement)
- Python edits: run `uv run ruff format` + `uv run ruff check --fix` after each file. (code-quality rule)

---

## File Structure

- `src/nodes/api/routes/health.py` — REPLACE scaffold. `GET /health` (liveness, no auth) + `GET /internal/health/deep` (auth'd; pogocache/mongo/snowflake checks).
- `src/nodes/api/app.py` — MODIFY. Mount the health router.
- `tests/unit/test_health.py` — CREATE. pytest coverage for both endpoints (mocked checks).
- `src/mastra/server.ts` — MODIFY. Add `GET /health/deep` (agent-LLM / xAI check).
- `src/mastra/__tests__/health.test.ts` — CREATE. bun test for `/health/deep` (stubbed fetch).
- `interface/scripts/preflight.mjs` — CREATE. Dependency-free preflight + table renderer.
- `interface/package.json` — MODIFY. `predev` + `check` scripts.
- `interface/.env.example` — MODIFY. Document the sidecar/secret vars the preflight reads.
- `tasks/progress.md`, `tasks/todo.md` — MODIFY. Log the work.

## Table shape (target output)

```
Credix backend preflight

  SERVICE          STATUS    DETAIL
  ---------------------------------------------------------------
  Hono server      OK        HTTP 200 http://localhost:3000
  Agent API (LLM)  DOWN      HTTP 401 (check GROK_API_KEY)
  FastAPI sidecar  OK        HTTP 200 http://localhost:8000
  Pogocache (L1)   OK        3 ms
  MongoDB (L2)     OK        41 ms
  Snowflake (L3)   DOWN      timeout after 12s

  1 of 6 services unavailable. Starting dev anyway (use --strict to block).
```

---

### Task 1: FastAPI liveness + deep readiness endpoints

Python has pytest, so this task is real red/green TDD.

**Files:**
- Create/replace: `src/nodes/api/routes/health.py`
- Modify: `src/nodes/api/app.py`
- Test: `tests/unit/test_health.py`

**Interfaces:**
- Produces: `GET /health` → `{"status":"ok"}` (no auth). `GET /internal/health/deep` (header `X-Internal-Token`) → `{"all_ok": bool, "services": [{"name","status","detail","latency_ms"}]}` with `name` in `{pogocache, mongodb, snowflake}` and `status` in `{ok, down}`.
- Consumes: `verify_internal_token` from `bureau_internal.py`; `connect` from `snowflake_client.py`.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/test_health.py`:

```python
from fastapi.testclient import TestClient

from nodes.api.app import app
from nodes.api.routes import health

client = TestClient(app)


def test_liveness_ok():
    res = client.get("/health")
    assert res.status_code == 200
    assert res.json() == {"status": "ok"}


def test_deep_requires_token():
    res = client.get("/internal/health/deep")
    assert res.status_code == 403


def test_deep_all_ok(monkeypatch):
    monkeypatch.setenv("INTERNAL_API_SECRET", "s3cret")
    monkeypatch.setattr(health, "_check_pogocache", lambda: None)
    monkeypatch.setattr(health, "_check_mongodb", lambda: None)
    monkeypatch.setattr(health, "_check_snowflake", lambda: None)
    res = client.get("/internal/health/deep", headers={"X-Internal-Token": "s3cret"})
    assert res.status_code == 200
    body = res.json()
    assert body["all_ok"] is True
    assert {s["name"] for s in body["services"]} == {"pogocache", "mongodb", "snowflake"}
    assert all(s["status"] == "ok" for s in body["services"])


def test_deep_reports_down_without_masking(monkeypatch):
    monkeypatch.setenv("INTERNAL_API_SECRET", "s3cret")

    def boom():
        raise RuntimeError("connection refused")

    monkeypatch.setattr(health, "_check_pogocache", boom)
    monkeypatch.setattr(health, "_check_mongodb", lambda: None)
    monkeypatch.setattr(health, "_check_snowflake", lambda: None)
    res = client.get("/internal/health/deep", headers={"X-Internal-Token": "s3cret"})
    assert res.status_code == 200
    body = res.json()
    assert body["all_ok"] is False
    by_name = {s["name"]: s for s in body["services"]}
    assert by_name["pogocache"]["status"] == "down"
    assert "connection refused" in by_name["pogocache"]["detail"]
    assert by_name["mongodb"]["status"] == "ok"
    assert by_name["snowflake"]["status"] == "ok"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/beast/Documents/Com/Credix && uv run pytest tests/unit/test_health.py -v`
Expected: FAIL (health router not mounted; `_check_*` don't exist).

- [ ] **Step 3: Implement `health.py`**

Replace the contents of `src/nodes/api/routes/health.py`:

```python
"""Liveness and deep readiness probes for the data sidecar.

- GET /health                — process liveness. No auth, no downstream calls.
- GET /internal/health/deep  — checks each backing store (Pogocache L1, MongoDB L2,
  Snowflake L3). Auth'd with X-Internal-Token. Every check runs isolated in its own
  thread with a timeout, so one dead store never masks another and the endpoint
  itself never raises.
"""

import os
import time
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeout

from fastapi import APIRouter, Depends

from .bureau_internal import verify_internal_token

router = APIRouter()


def _timed(fn, timeout: float = 12.0) -> dict:
    start = time.monotonic()
    try:
        with ThreadPoolExecutor(max_workers=1) as pool:
            pool.submit(fn).result(timeout=timeout)
        status, detail = "ok", ""
    except FutureTimeout:
        status, detail = "down", f"timeout after {int(timeout)}s"
    except Exception as exc:  # noqa: BLE001 - health must never raise
        status, detail = "down", f"{type(exc).__name__}: {exc}"[:200]
    return {
        "status": status,
        "detail": detail,
        "latency_ms": round((time.monotonic() - start) * 1000),
    }


def _check_pogocache() -> None:
    import redis

    client = redis.Redis.from_url(
        os.environ.get("REDIS_URL", "redis://localhost:9401"),
        decode_responses=True,
        protocol=2,
        socket_connect_timeout=2,
        socket_timeout=2,
    )
    try:
        client.ping()
    finally:
        client.close()


def _check_mongodb() -> None:
    from pymongo import MongoClient

    uri = os.environ.get("MONGODB_URI", "")
    if not uri:
        raise RuntimeError("MONGODB_URI not set")
    client = MongoClient(uri, serverSelectionTimeoutMS=3000)
    try:
        client.admin.command("ping")
    finally:
        client.close()


def _check_snowflake() -> None:
    from nodes.raw_data.bureau.snowflake_client import connect

    conn = connect()
    try:
        cur = conn.cursor()
        try:
            cur.execute("SELECT 1")
            cur.fetchone()
        finally:
            cur.close()
    finally:
        conn.close()


@router.get("/health")
def health() -> dict:
    return {"status": "ok"}


@router.get("/internal/health/deep", dependencies=[Depends(verify_internal_token)])
def health_deep() -> dict:
    services = [
        {"name": "pogocache", **_timed(_check_pogocache)},
        {"name": "mongodb", **_timed(_check_mongodb)},
        {"name": "snowflake", **_timed(_check_snowflake)},
    ]
    return {
        "all_ok": all(s["status"] == "ok" for s in services),
        "services": services,
    }
```

- [ ] **Step 4: Mount the router in `app.py`**

Replace the contents of `src/nodes/api/app.py`:

```python
"""FastAPI application factory. Data sidecar only — Hono owns the public API."""

from fastapi import FastAPI

from .routes import bureau_internal, health


def create_app() -> FastAPI:
    app = FastAPI(title="Credit Credix Sidecar", version="0.1.0")
    app.include_router(bureau_internal.router)
    app.include_router(health.router)
    return app


app = create_app()
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /home/beast/Documents/Com/Credix && uv run pytest tests/unit/test_health.py -v`
Expected: 4 passed.

- [ ] **Step 6: Lint**

Run: `cd /home/beast/Documents/Com/Credix && uv run ruff format src/nodes/api/routes/health.py src/nodes/api/app.py tests/unit/test_health.py && uv run ruff check src/nodes/api/routes/health.py src/nodes/api/app.py tests/unit/test_health.py --fix`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
cd /home/beast/Documents/Com/Credix
git add src/nodes/api/routes/health.py src/nodes/api/app.py tests/unit/test_health.py
git commit -m "api: add sidecar liveness + deep readiness probes for L1/L2/L3 stores

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Hono `/health/deep` agent-LLM probe

**Files:**
- Modify: `src/mastra/server.ts` (add route + import)
- Test: `src/mastra/__tests__/health.test.ts`

**Interfaces:**
- Produces: `GET /health/deep` → `{ all_ok: boolean, services: [{ name: 'agent_llm', status: 'ok'|'down', detail: string, latency_ms: number }] }`. Never throws; a missing key or non-2xx from xAI becomes `status: 'down'`.
- Consumes: `GROK_BASE_URL` from `./lib/provider`.

- [ ] **Step 1: Write the failing test**

Create `src/mastra/__tests__/health.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'bun:test'
import { app } from '../server'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

describe('GET /health/deep', () => {
  it('reports agent_llm ok when xAI responds 200', async () => {
    process.env.GROK_API_KEY = 'xai-test'
    globalThis.fetch = (async () => new Response('{}', { status: 200 })) as typeof fetch
    const res = await app.request('/health/deep')
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    const llm = body.services.find((s: any) => s.name === 'agent_llm')
    expect(llm.status).toBe('ok')
    expect(body.all_ok).toBe(true)
  })

  it('reports agent_llm down when xAI responds 401', async () => {
    process.env.GROK_API_KEY = 'xai-bad'
    globalThis.fetch = (async () => new Response('no', { status: 401 })) as typeof fetch
    const res = await app.request('/health/deep')
    const body = (await res.json()) as any
    const llm = body.services.find((s: any) => s.name === 'agent_llm')
    expect(llm.status).toBe('down')
    expect(llm.detail).toContain('401')
    expect(body.all_ok).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/beast/Documents/Com/Credix/src/mastra && bun test __tests__/health.test.ts`
Expected: FAIL (route 404).

- [ ] **Step 3: Add the import**

In `src/mastra/server.ts`, add to the imports near `import { fetchBureau } from './lib/bureau-fetch'`:

```ts
import { GROK_BASE_URL } from './lib/provider'
```

- [ ] **Step 4: Add the route**

In `src/mastra/server.ts`, immediately after `app.get('/health', (c) => c.json({ ok: true }))`, insert:

```ts
// Deep readiness for the agent brain. Probes xAI (the LLM every agent calls) with a bounded,
// non-throwing check so the preflight can render a status row. No secret is returned.
app.get('/health/deep', async (c) => {
  const start = Date.now()
  let status = 'ok'
  let detail = ''
  try {
    const key = process.env.GROK_API_KEY ?? ''
    if (!key) throw new Error('GROK_API_KEY not set')
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 8000)
    try {
      const res = await fetch(`${GROK_BASE_URL}/models`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: ctrl.signal,
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
    } finally {
      clearTimeout(timer)
    }
  } catch (err) {
    status = 'down'
    detail = err instanceof Error ? (err.name === 'AbortError' ? 'timeout after 8s' : err.message) : 'unknown'
  }
  const services = [{ name: 'agent_llm', status, detail, latency_ms: Date.now() - start }]
  return c.json({ all_ok: services.every((s) => s.status === 'ok'), services })
})
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd /home/beast/Documents/Com/Credix/src/mastra && bun test __tests__/health.test.ts`
Expected: 2 pass.

- [ ] **Step 6: Typecheck + full suite**

Run: `cd /home/beast/Documents/Com/Credix/src/mastra && bunx tsc --noEmit && bun test`
Expected: tsc exit 0; suite green (163 pass baseline + 2 new).

- [ ] **Step 7: Commit**

```bash
cd /home/beast/Documents/Com/Credix
git add src/mastra/server.ts src/mastra/__tests__/health.test.ts
git commit -m "api: add Hono /health/deep probing the xAI agent LLM; non-throwing

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Preflight script + npm wiring

No unit runner in `interface/`; verify by running the script against known up/down states.

**Files:**
- Create: `interface/scripts/preflight.mjs`
- Modify: `interface/package.json`
- Modify: `interface/.env.example`

**Interfaces:**
- Consumes: Task 1 `GET /internal/health/deep`, Task 2 `GET /health/deep`, plus `GET /health` on both servers.
- Produces: `npm run dev` prints the status table before Next starts; `npm run check` runs it standalone.

- [ ] **Step 1: Create the preflight script**

Create `interface/scripts/preflight.mjs`:

```js
#!/usr/bin/env node
// Credix backend preflight. Runs before `next dev` (npm predev hook).
// Warn-then-continue by default (exit 0). --strict or PREFLIGHT_STRICT=1 -> exit 1 on any
// DOWN/UNKNOWN. SKIP_PREFLIGHT=1 bypasses entirely. Dependency-free, never throws.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

if (process.env.SKIP_PREFLIGHT === "1") process.exit(0);

const strict = process.argv.includes("--strict") || process.env.PREFLIGHT_STRICT === "1";
const scriptDir = dirname(fileURLToPath(import.meta.url));
const interfaceDir = dirname(scriptDir);
const repoRoot = dirname(interfaceDir);

function loadEnv(path) {
  try {
    const out = {};
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (!m) continue;
      let v = m[2].replace(/\s+#.*$/, "").trim(); // strip inline comment
      v = v.replace(/^["']|["']$/g, ""); // strip wrapping quotes
      out[m[1]] = v;
    }
    return out;
  } catch {
    return {};
  }
}

// repo-root .env holds sidecar url + secret; interface/.env.local holds CREDIX_API_URL.
// Real process env wins over file values.
const env = {
  ...loadEnv(join(repoRoot, ".env")),
  ...loadEnv(join(interfaceDir, ".env.local")),
  ...process.env,
};

const HONO = env.CREDIX_API_URL || "http://localhost:3000";
const SIDECAR = env.BUREAU_SIDECAR_URL || "http://localhost:8000";
const SECRET = env.INTERNAL_API_SECRET || "";

async function probe(url, opts = {}, timeoutMs = 5000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    const body = await res.json().catch(() => ({}));
    return { reachable: true, ok: res.ok, status: res.status, body };
  } catch (e) {
    return { reachable: false, ok: false, status: 0, error: e.name === "AbortError" ? "timeout" : e.code || e.message };
  } finally {
    clearTimeout(timer);
  }
}

const rows = [];
const add = (service, status, detail) => rows.push({ service, status, detail });

// 1. Hono server liveness
const honoLive = await probe(`${HONO}/health`, {}, 4000);
add("Hono server", honoLive.reachable && honoLive.ok ? "OK" : "DOWN",
  honoLive.reachable ? `HTTP ${honoLive.status} ${HONO}` : `${honoLive.error} ${HONO}`);

// 2. Agent API (xAI Grok LLM) via Hono deep health
if (honoLive.reachable) {
  const deep = await probe(`${HONO}/health/deep`, {}, 10000);
  const llm = deep.body?.services?.find((s) => s.name === "agent_llm");
  if (llm) add("Agent API (LLM)", llm.status === "ok" ? "OK" : "DOWN", llm.detail || `${llm.latency_ms} ms`);
  else add("Agent API (LLM)", "UNKNOWN", "no agent_llm in /health/deep");
} else {
  add("Agent API (LLM)", "UNKNOWN", "Hono server down");
}

// 3. FastAPI sidecar liveness
const sideLive = await probe(`${SIDECAR}/health`, {}, 4000);
add("FastAPI sidecar", sideLive.reachable && sideLive.ok ? "OK" : "DOWN",
  sideLive.reachable ? `HTTP ${sideLive.status} ${SIDECAR}` : `${sideLive.error} ${SIDECAR}`);

// 4-6. Data layer via sidecar deep health (Pogocache / MongoDB / Snowflake)
const labels = { pogocache: "Pogocache (L1)", mongodb: "MongoDB (L2)", snowflake: "Snowflake (L3)" };
if (sideLive.reachable) {
  const deep = await probe(`${SIDECAR}/internal/health/deep`, { headers: { "X-Internal-Token": SECRET } }, 15000);
  if (deep.status === 403) {
    for (const name of Object.keys(labels)) add(labels[name], "UNKNOWN", "sidecar auth failed (INTERNAL_API_SECRET)");
  } else if (deep.reachable && deep.body?.services) {
    const by = Object.fromEntries(deep.body.services.map((s) => [s.name, s]));
    for (const name of Object.keys(labels)) {
      const s = by[name];
      if (!s) add(labels[name], "UNKNOWN", "not reported");
      else add(labels[name], s.status === "ok" ? "OK" : "DOWN", s.detail || `${s.latency_ms} ms`);
    }
  } else {
    for (const name of Object.keys(labels)) add(labels[name], "UNKNOWN", "deep health unreachable");
  }
} else {
  for (const name of Object.keys(labels)) add(labels[name], "UNKNOWN", "sidecar down");
}

// Render table (no emojis).
const wService = Math.max(7, ...rows.map((r) => r.service.length));
const wStatus = Math.max(6, ...rows.map((r) => r.status.length));
const line = "  " + "-".repeat(wService + wStatus + 40);
console.log("\nCredix backend preflight\n");
console.log("  " + "SERVICE".padEnd(wService) + "  " + "STATUS".padEnd(wStatus) + "  DETAIL");
console.log(line);
for (const r of rows) {
  console.log("  " + r.service.padEnd(wService) + "  " + r.status.padEnd(wStatus) + "  " + r.detail);
}

const bad = rows.filter((r) => r.status !== "OK");
console.log("");
if (bad.length === 0) {
  console.log(`  All ${rows.length} services OK.\n`);
  process.exit(0);
}
if (strict) {
  console.log(`  ${bad.length} of ${rows.length} services unavailable. Blocking (--strict).\n`);
  process.exit(1);
}
console.log(`  ${bad.length} of ${rows.length} services unavailable. Starting dev anyway (use --strict to block).\n`);
process.exit(0);
```

- [ ] **Step 2: Wire npm scripts**

In `interface/package.json` `scripts`, add `predev` and `check` around the existing `dev` (which Task 4 of the wiring plan set to `next dev --turbopack`):

```json
    "predev": "node scripts/preflight.mjs",
    "dev": "next dev --turbopack",
    "check": "node scripts/preflight.mjs",
```

- [ ] **Step 3: Document env in `.env.example`**

Append to `interface/.env.example`:

```
# Read by scripts/preflight.mjs (dev healthcheck). These normally live in the repo-root .env;
# the preflight reads that automatically. Override here only for a non-default local setup.
# BUREAU_SIDECAR_URL=http://localhost:8000
# INTERNAL_API_SECRET=
```

- [ ] **Step 4: Verify DOWN path (backends off)**

Run: `cd /home/beast/Documents/Com/Credix/interface && node scripts/preflight.mjs`
Expected: the table prints with `Hono server DOWN`, `FastAPI sidecar DOWN`, and the LLM + data rows `UNKNOWN`; final line "Starting dev anyway"; exit code 0. Confirm: `echo $?` → `0`.

- [ ] **Step 5: Verify strict blocks**

Run: `cd /home/beast/Documents/Com/Credix/interface && node scripts/preflight.mjs --strict; echo "exit=$?"`
Expected: same table, final line "Blocking (--strict)", `exit=1`.

- [ ] **Step 6: Verify skip bypasses**

Run: `cd /home/beast/Documents/Com/Credix/interface && SKIP_PREFLIGHT=1 node scripts/preflight.mjs; echo "exit=$?"`
Expected: no table, `exit=0`.

- [ ] **Step 7: Verify OK path (backends on)**

Start the FastAPI sidecar (`cd /home/beast/Documents/Com/Credix && uv run uvicorn nodes.api.app:app --port 8000`) and Hono (`cd src/mastra && pnpm dev`), with Pogocache/Mongo/Snowflake reachable and a valid `GROK_API_KEY`. Then:
Run: `cd /home/beast/Documents/Com/Credix/interface && npm run check`
Expected: all reachable rows `OK`; any genuinely-down store shows `DOWN` with a real reason (e.g. Snowflake `timeout after 12s`). This is the acceptance shot.

- [ ] **Step 8: Commit**

```bash
cd /home/beast/Documents/Com/Credix
git add interface/scripts/preflight.mjs interface/package.json interface/.env.example
git commit -m "frontend: add dev preflight healthcheck; predev prints backend status table

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Session notes

**Files:**
- Modify: `tasks/progress.md`, `tasks/todo.md`

- [ ] **Step 1: Log the work**

Append a dated entry to `tasks/progress.md` (endpoints added, preflight behavior, verify results) and add a completed phase line to `tasks/todo.md`.

- [ ] **Step 2: Commit**

```bash
cd /home/beast/Documents/Com/Credix
git add tasks/progress.md tasks/todo.md
git commit -m "docs: log dev preflight healthcheck implementation

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Requirement coverage:**
- Check Pogocache/MongoDB/Snowflake → Task 1 (`_check_*`, `/internal/health/deep`).
- Check Hono server → Task 3 Step 1 (`GET /health`).
- Check agent API as two rows (LLM + sidecar) → Task 2 (LLM) + Task 3 (sidecar `/health`).
- Graceful error handling, return errors → `_timed` isolation + non-throwing Hono route + `probe` try/catch; every failure becomes a `DOWN`/`UNKNOWN` row with a detail string.
- Table, one-by-one, no emojis → Task 3 renderer, statuses `OK/DOWN/UNKNOWN`.
- Runs on `npm run dev` → `predev` hook (Task 3 Step 2).
- Warn-then-start (user decision) → exit 0 default, `--strict` to block.

**Placeholder scan:** none — every step has complete code or an exact command with expected output.

**Type/name consistency:** service `name` values (`pogocache`, `mongodb`, `snowflake`, `agent_llm`) are identical across the Python endpoint, the Hono endpoint, and the preflight's `labels`/lookups. Auth header `X-Internal-Token` matches `verify_internal_token`. Endpoint paths (`/health`, `/health/deep`, `/internal/health/deep`) match between producers and the preflight consumer.

**Dependency note:** Task 3 Step 2 assumes the interface-wiring plan's `dev` script (`next dev --turbopack`). If that plan hasn't run, set `dev` accordingly in the same edit.

**Known cost:** the Snowflake deep check runs `SELECT 1`, which can resume the warehouse. It is time-boxed to 12s and only runs when `/internal/health/deep` is called (preflight / manual), not on the hot path.
```
