# Issue 001 — Foundation: Hono Server + Mastra Bootstrap + Python Data Sidecar

**Type:** AFK
**Blocked by:** None — start immediately
**PRD sections:** Problem Statement, Solution §proxy-pattern, Implementation Decisions §1–3, Ops stories 24–28

---

## Architecture decision baked into this issue

FastAPI is no longer the public-facing API. Responsibility split:

| Layer | Technology | Port | What it owns |
|---|---|---|---|
| Public API | **Hono (TypeScript)** | 3000 | `POST /v1/chat`, health check, identity pre-check |
| Agent layer | **Mastra** | 2024 (dev only) | Workflow execution, agents, memory — called in-process by Hono |
| Data sidecar | **FastAPI (Python)** | 8000 (internal) | `GET /internal/bureau/{user_id}`, `GET /internal/bureau/{user_id}/{section}` only |

Hono calls `credixWorkflow.execute()` in-process — no HTTP hop between API and agent. This eliminates the entire class of response-shape deserialization bugs.

---

## What to build

Bootstrap the TypeScript Mastra project under `src/mastra/`, create the Hono public API server at `src/server.ts`, and slim the Python FastAPI app to a data-only sidecar. When this issue is done:

- `pnpm dev` (or `node src/server.ts`) starts Hono on port 3000
- `POST /v1/chat` returns a structured response (stub until Issue 4 wires the full workflow)
- `mastra dev` starts Mastra Studio on port 2024 (for debugging)
- `GET /internal/bureau/{user_id}` returns bureau data or 404 from Python sidecar
- No import crash on any route

---

## Exact deliverables

### 1. `src/mastra/package.json`

```json
{
  "name": "credix-mastra",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "node --import tsx/esm src/server.ts",
    "mastra:dev": "mastra dev",
    "build": "mastra build",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@mastra/core": "latest",
    "@mastra/memory": "latest",
    "@mastra/libsql": "latest",
    "@ai-sdk/openai": "latest",
    "hono": "^4.0.0",
    "@hono/node-server": "^1.0.0",
    "@hono/zod-validator": "^0.4.0",
    "zod": "^4.0.0"
  },
  "devDependencies": {
    "typescript": "^5.0.0",
    "@types/node": "^22.0.0",
    "mastra": "latest",
    "vitest": "^2.0.0",
    "tsx": "^4.0.0"
  }
}
```

> `@ai-sdk/openai` is a required explicit dependency — it is NOT bundled inside `@mastra/core`. Missing it causes a runtime import error. `tsx` is needed to run `.ts` files directly in development.

### 2. `src/mastra/tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["**/*.ts"]
}
```

> `moduleResolution: "bundler"` is mandatory. Using `"node"` or `"commonjs"` causes Mastra import errors at runtime — the package uses export maps that only resolve under `"bundler"`. This is a non-negotiable constraint; do not change it.

### 3. `src/mastra/index.ts` — partial stub (final registration in Issue 4)

```typescript
import { Mastra } from '@mastra/core'
import { LibSQLStore } from '@mastra/libsql'

// Shared storage instance — also used by Memory in Issue 4
export const libsqlStore = new LibSQLStore({
  id: 'credix-storage',
  url: process.env.MASTRA_DB_URL ?? 'file:./mastra.db',
})

// Agents and workflow registered in Issue 4 — do NOT add them here
// Adding them before they exist causes import errors that block `pnpm typecheck`
export const mastra = new Mastra({
  storage: libsqlStore,
})
```

> Export `libsqlStore` as a named export. `Memory` in Issue 4 must import this SAME instance — sharing the store is what makes agent memory persist to the same database file. If `Memory` creates its own `LibSQLStore`, it uses a separate file and working memory never accumulates across sessions.

### 4. `src/mastra/lib/provider.ts`

```typescript
import { createOpenAI } from '@ai-sdk/openai'

if (!process.env.GROK_API_KEY) {
  console.warn('[provider] GROK_API_KEY not set — LLM calls will fail at runtime')
}

export const grokProvider = createOpenAI({
  baseURL: 'https://api.x.ai/v1',
  apiKey: process.env.GROK_API_KEY ?? '',
})

// Import this in any step or agent that calls an LLM — never instantiate a new provider inline
export const grokModel = grokProvider(process.env.LLM_MODEL ?? 'grok-3')
```

### 5. `src/mastra/lib/patterns.ts`

```typescript
// ─── Injection patterns — pre-guardrail step, checked on decoded user input ───
export const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(previous|prior)\s+instructions?/i,
  /act\s+as\s+(if\s+you\s+are|a)/i,
  /jailbreak/i,
  /\bDAN\b/,
  /pretend\s+you\s+are/i,
  /system\s+prompt/i,
  /new\s+instructions?/i,
  /disregard\s+(all|previous)/i,
]

// ─── Out-of-scope topic patterns — pre-guardrail step ───
export const SCOPE_PATTERNS: RegExp[] = [
  /\b(recipe|cooking|food)\b/i,
  /\b(cricket|IPL|football|sports\s+score)\b/i,
  /\b(weather|temperature\s+today)\b/i,
  /\b(astrology|horoscope|zodiac)\b/i,
  /\b(stock\s+price|market\s+cap|nifty|sensex)\b/i,
]

// ─── PII patterns — post-guardrail step, checked on agent output ───
// PAN: 5 uppercase letters + 4 digits + 1 uppercase letter
export const PAN_PATTERN = /\b[A-Z]{5}[0-9]{4}[A-Z]\b/g
// Aadhaar: 12 digits optionally space-separated in groups of 4
export const AADHAAR_PATTERN = /\b\d{4}\s?\d{4}\s?\d{4}\b/g
// Indian mobile: starts 6–9, followed by 9 more digits
export const MOBILE_PATTERN = /\b[6-9]\d{9}\b/g
// CIBIL scores (300–900, always 3 digits) are intentionally NOT redacted

// ─── Canonical intent values — shared between understand step and workflow branch ───
export const INTENT_VALUES = [
  'bureau_query',
  'score_improvement',
  'credit_card',
  'insurance',
  'general',
] as const
export type Intent = typeof INTENT_VALUES[number]

// ─── Canonical step IDs — must match createStep({ id }) exactly ───
// getStepResult() uses these strings. A mismatch silently returns undefined.
export const STEP_IDS = {
  DECODE: 'decode',
  PRE_GUARDRAIL: 'pre-guardrail',
  UNDERSTAND: 'understand',
  POST_GUARDRAIL: 'post-guardrail',
  MEMORY_WRITEBACK: 'memory-writeback',
  COMPOSE: 'compose',
  GUARDRAIL_REJECT: 'guardrail-reject',
  SCORE_IMPROVEMENT: 'score_improvement',
  CREDIT_CARD: 'credit_card',
  INSURANCE: 'insurance',
  GENERAL: 'general',
} as const
```

> All regex patterns live here. Never add a regex literal inside a step file. When a new out-of-scope topic needs blocking, add it to `SCOPE_PATTERNS` — it applies automatically everywhere. `STEP_IDS` and `INTENT_VALUES` are also canonical here so there is exactly one place to look up any string identifier.

### 6. `src/server.ts` — Hono public API

```typescript
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'

// NOTE: mastra import deferred until Issue 4 wires the workflow.
// For Issue 1, stub the workflow call so the server starts cleanly.

const app = new Hono()

const SIDECAR_URL = process.env.BUREAU_SIDECAR_URL ?? 'http://localhost:8000'
const INTERNAL_TOKEN = process.env.INTERNAL_API_SECRET ?? ''

// Normalize any mobile format to bare 10 digits (mirrors Python mobile_to_user_id)
function normalizeUserId(mobile: string): string {
  const digits = mobile.replace(/\D/g, '')
  return digits.startsWith('91') && digits.length === 12 ? digits.slice(2) : digits.slice(-10)
}

const chatSchema = z.object({
  mobile: z.string().min(10),
  message: z.string().min(1),
  session_id: z.string().optional(),
  channel: z.enum(['web', 'whatsapp', 'tts']).default('web'),
})

app.post('/v1/chat', zValidator('json', chatSchema), async (c) => {
  const body = c.req.valid('json')
  const user_id = normalizeUserId(body.mobile)
  const session_id = body.session_id ?? crypto.randomUUID()

  // Identity pre-check at the API boundary (not inside the workflow)
  // Keeps the Mastra workflow pure — it only processes verified users
  const bureauRes = await fetch(`${SIDECAR_URL}/internal/bureau/${user_id}`, {
    headers: { 'X-Internal-Token': INTERNAL_TOKEN },
  })

  if (bureauRes.status === 404) {
    return c.json({
      response: "We couldn't find a bureau record for this number. Please try with your registered bank mobile number.",
      session_id,
      active_skill: 'not_found',
    })
  }

  if (!bureauRes.ok) {
    return c.json({ error: `Bureau sidecar unavailable: ${bureauRes.status}` }, 502)
  }

  const bureau_profile = await bureauRes.json()

  // Issue 1 stub — workflow wired in Issue 4
  // Replace the block below with the real workflow call in Issue 4:
  //
  // import { mastra } from './mastra/index'
  // const run = mastra.getWorkflow('credix-workflow').createRun()
  // const result = await run.start({
  //   inputData: { user_id, message: body.message, session_id, channel: body.channel, bureau_profile },
  // })
  // if (result.status !== 'success') return c.json({ error: 'workflow failed' }, 502)
  // return c.json({ response: result.result.composed, session_id, active_skill: result.result.active_skill })

  return c.json({
    response: `[stub] Workflow not yet wired. user_id: ${user_id}, session_id: ${session_id}`,
    session_id,
    active_skill: 'stub',
  })
})

app.get('/health', (c) => c.json({ ok: true, ts: Date.now() }))

serve({
  fetch: app.fetch,
  port: Number(process.env.PORT ?? 3000),
})

console.log(`[server] Hono listening on port ${process.env.PORT ?? 3000}`)
```

### 7. Python data sidecar — `src/credit_credix/api/routes/bureau_internal.py`

This file replaces the old bureau routes. The chat route (`/v1/chat`) is **removed from FastAPI** — Hono owns it now.

```python
import os
from fastapi import APIRouter, HTTPException, Header, Depends
from credit_credix.raw_data.bureau.factory import get_resolver
from credit_credix.raw_data.bureau.redis_client import RedisRepo

router = APIRouter(prefix="/internal")

VALID_SECTIONS = frozenset({
    "general_info", "loan_details", "enquiries", "loan_repayments",
    "loan_patterns", "borrowing_window", "institution_details", "dpd",
})


async def verify_internal_token(x_internal_token: str = Header(...)) -> None:
    expected = os.getenv("INTERNAL_API_SECRET", "")
    if not expected or x_internal_token != expected:
        raise HTTPException(status_code=403, detail="Forbidden")


@router.get("/bureau/{user_id}", dependencies=[Depends(verify_internal_token)])
async def get_bureau_profile(user_id: str):
    profile = await get_resolver().resolve(user_id)
    if not profile:
        raise HTTPException(status_code=404, detail="No bureau record found")
    # pii key is stripped by RedisRepo before write — assert it never leaks here
    profile.pop("pii", None)
    return profile


@router.get("/bureau/{user_id}/{section}", dependencies=[Depends(verify_internal_token)])
async def get_bureau_section(user_id: str, section: str):
    if section not in VALID_SECTIONS:
        raise HTTPException(status_code=400, detail=f"Unknown section '{section}'. Valid: {sorted(VALID_SECTIONS)}")
    repo = RedisRepo()
    data = await repo.get_path(user_id, f"$.{section}")
    if data is None:
        await get_resolver().resolve(user_id)
        data = await repo.get_path(user_id, f"$.{section}")
    if data is None:
        raise HTTPException(status_code=404, detail=f"Section '{section}' not found for user")
    return {section: data}
```

> `verify_internal_token` is a FastAPI `Depends` function, not a manually-called helper. Using `Depends` is the correct FastAPI pattern — it runs before the route handler and raises 403 automatically. The old draft called it manually which bypassed FastAPI's dependency injection.

Register this router in `src/credit_credix/api/app.py`. Remove the existing chat router registration — Hono owns `POST /v1/chat` now.

### 8. `.env.example` additions

```bash
# TypeScript / Mastra layer
GROK_API_KEY=                        # xAI API key — required
LLM_MODEL=grok-3                     # model name passed to grokProvider()
MASTRA_DB_URL=file:./mastra.db       # LibSQL storage path
PORT=3000                            # Hono server port

# Internal service addresses
BUREAU_SIDECAR_URL=http://localhost:8000  # Python data sidecar base URL
INTERNAL_API_SECRET=change-me-in-production  # shared secret for /internal/* routes
```

---

## Local startup sequence

```bash
# Terminal 1 — Python data sidecar (port 8000)
cd /home/beast/Documents/Com/Credix
uv run uvicorn credit_credix.api.app:app --port 8000

# Terminal 2 — Hono public API (port 3000)
cd src/mastra
pnpm dev

# Terminal 3 — Mastra Studio (port 2024, optional, for debugging)
cd src/mastra
pnpm mastra:dev
```

In production: Hono + Python sidecar run as separate systemd services. Mastra Studio does not run in production.

---

## Acceptance criteria

- [ ] `pnpm install` from `src/mastra/` exits 0
- [ ] `pnpm typecheck` exits 0 with the stub `index.ts`
- [ ] `pnpm dev` starts Hono on port 3000 without errors
- [ ] `POST /v1/chat { "mobile": "9876543210", "message": "test" }` returns HTTP 200 with stub response (not a 500)
- [ ] `GET /internal/bureau/9876543210` without `X-Internal-Token` header → 403
- [ ] `GET /internal/bureau/9876543210` with correct token and no bureau record → 404 (not 500)
- [ ] `GET /internal/bureau/9876543210/invalid_section` → 400 with valid sections list
- [ ] Response from `GET /internal/bureau/{user_id}` never contains a `pii` key
- [ ] `tasks/todo.md`: Issue 001 complete, Issue 002 in_progress
- [ ] `tasks/progress.md`: entry written with files created/modified
- [ ] `tasks/findings.md`: note `moduleResolution: "bundler"` is required and `@ai-sdk/openai` is an explicit dependency

## Key constraints to carry forward

- `libsqlStore` is exported from `src/mastra/index.ts` and MUST be imported (not re-instantiated) in `memory/index.ts` in Issue 4
- `INTERNAL_API_SECRET` is read at request time, never cached at module load
- The `pii` key is stripped by `RedisRepo` at write time in Python; the `profile.pop("pii", None)` in the sidecar route is a defence-in-depth guard, not the primary mechanism
- `STEP_IDS` in `patterns.ts` are the canonical step ID strings — every `createStep({ id })` call must use these constants
- `INTENT_VALUES` in `patterns.ts` is the canonical intent enum — the understand step and workflow branch must both reference it from here
