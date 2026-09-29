# Design: Wire `interface/` frontend to the Mastra credix workflow

Date: 2026-07-01
Status: Approved (design), pending implementation plan
Branch context: `feat/bureau-python-wrapper`

## Goal

Rename the untracked `rahul-front/` Next.js scaffold to `interface/` and connect it,
end to end, to the real backend: the Mastra `credixWorkflow` exposed by the Hono
server at `POST /v1/chat`. Remove the dead LangGraph/"captain" wiring the scaffold was
built against.

## Problem

The frontend and the backend speak different protocols:

- **Frontend today** (`rahul-front/`): built on the LangGraph SDK — `client.runs.stream`,
  `client.threads.create`, graph id `"captain"`, streamed node names
  `synthesizer`/`identity_check`, a `/api/[..._path]` proxy to a LangGraph server on
  `:2024`, and a phone-input intro screen that calls a **deleted** "captain" FastAPI on
  `:8080` (`/api/v1/auth/verify-mobile`, `/user/profile/{token}`,
  `/user/intro-message-1|2/{token}`).
- **Backend today** (`src/mastra/server.ts`): a **non-streaming** Hono JSON endpoint
  `POST /v1/chat` on port **3000**. No CORS, no per-request auth.

None of the LangGraph endpoints, the `:2024` server, or the `:8080` captain backend
exist in this repo. The PRD already records the intent (Out of Scope, line ~305):
"`rahul-front` Next.js frontend updates to call Mastra server instead of the deleted
LangGraph server."

## Verified backend contract (`src/mastra/server.ts`)

`POST /v1/chat` on port 3000 (default; `PORT` env; 2024 is forbidden — Mastra Studio):

Request body (zod `chatSchema`):

| field | type | required |
|---|---|---|
| `mobile` | string, min 10 | yes |
| `message` | string, min 1 | yes |
| `session_id` | string | no (server mints a UUID if absent) |
| `channel` | `'web' \| 'whatsapp' \| 'tts'`, default `'web'` | no |

Responses:

| status | shape | meaning |
|---|---|---|
| 200 | `{ response, session_id, active_skill }` | success |
| 200 | `{ response, session_id, active_skill: 'not_found' }` | no bureau record — still has user-facing `response` |
| 400 | `{ error }` | invalid mobile or body schema failure |
| 502 | `{ error, detail }` | bureau sidecar unavailable OR workflow failed |
| 500 | `{ success: false, error: { message, code } }` | unhandled (global `onError`) |

Two facts that shape the design:

1. **No CORS** on the Hono app → the browser cannot call `/v1/chat` directly
   cross-origin. A same-origin Next.js proxy is **mandatory**, not a convenience.
2. **No per-request auth** on `/v1/chat` (`INTERNAL_API_SECRET` only guards process
   startup and the FastAPI bureau sidecar). The proxy therefore does **not** inject a
   required chat secret. Keeping the backend URL server-side in the proxy is still
   correct: it avoids CORS and leaves a seam to add auth later.

## Decisions (from brainstorming)

- **Auth/onboarding: phone capture only.** No OTP, no `:8080`. User enters a mobile,
  we validate format client-side and send it as `mobile`.
- **Transport: single request/response, production-shaped.** Chosen over SSE token
  streaming for a concrete safety reason: `postGuardrailStep` performs full PII
  redaction (CIBIL score, name, PAN) on the composed output. Streaming raw agent
  tokens would bypass that redaction and leak PII. Real SSE would require a
  streaming-aware guardrail — a separate, larger effort, out of scope. The single
  response is animated client-side (typewriter) for perceived latency.

## Architecture

```
Browser (interface/, Next.js)
  └─ PhoneInputScreen  ── captures mobile, mints sessionId (crypto.randomUUID)
  └─ AuthenticatedApp  ── useCredixRuntime(mobile, sessionId)
        └─ ChatModelAdapter.run()  ── POST /api/chat { mobile, message, session_id, channel:'web' }
              │  (same-origin — no CORS)
              ▼
  Next.js route  interface/app/api/chat/route.ts  (server-side)
        └─ POST ${CREDIX_API_URL}/v1/chat        (CREDIX_API_URL default http://localhost:3000)
              ▼
  Hono server  src/mastra/server.ts  →  mastra.getWorkflow('credixWorkflow')
```

### Components

1. **`interface/app/api/chat/route.ts`** (new) — server-side POST proxy to
   `${CREDIX_API_URL}/v1/chat`. Forwards the JSON body and the upstream status code.
   Keeps `CREDIX_API_URL` out of the browser. Replaces the deleted
   `app/api/[..._path]/route.ts` (LangGraph proxy).

2. **`interface/lib/useCredixRuntime.ts`** (new) — a `useLocalRuntime`
   `ChatModelAdapter`:
   - Reads the latest user text; POSTs `{ mobile, message, session_id, channel:'web' }`
     to `/api/chat`.
   - On 2xx: persists the returned `session_id` (localStorage), yields the full
     `response` (existing UI animates it).
   - Supports `abortSignal`; applies a request timeout (e.g. 60s via `AbortController`).
   - On non-2xx or network error: yields distinct friendly copy — `not_found` message
     already arrives as a 200 `response`; 502 → "having trouble reaching your data";
     timeout/other → generic retry copy. Never a blank bubble.
   - Replaces `useCustomLangGraphRuntime.ts` and `chatApi.ts` (both deleted).

3. **`interface/components/ui/phone-input-screen.tsx`** (edit) — keep the typed intro
   animation. `onSubmit` no longer calls `:8080`: validate (zod, last-10-digits),
   build `AuthState { mobile, sessionId }`, proceed. The **first** intro bubble is
   powered by **one real `/api/chat` seed call** (a friendly onboarding prompt); on
   failure it falls back to static copy. The second bubble becomes static tagline copy
   (no second network call). `firstName` is dropped (real names are PII-stripped before
   reaching the browser). `AuthState` becomes `{ mobile, sessionId }`.

4. **`interface/app/assistant.tsx`** (edit) — swap runtime hook + `AuthState` shape;
   store `session_id` (backend-owned) in place of the LangGraph `thread_id`. "New
   conversation" clears the stored session id.

### Session continuity

The backend owns `session_id` (mints one if omitted, echoes it back). The client
stores the returned `session_id` in localStorage and sends it on every turn so Mastra
memory threads correctly. Replaces the LangGraph `thread_id` concept entirely.

## Deletions / cleanup

- Delete: `backend/agent.ts`, `langgraph.json`, `app/api/[..._path]/route.ts`,
  `lib/chatApi.ts`, `lib/useCustomLangGraphRuntime.ts`.
- Remove deps from `package.json`: `@assistant-ui/react-langgraph`,
  `@langchain/anthropic`, `@langchain/langgraph`, `@langchain/langgraph-sdk`,
  `@langchain/core`, `@langchain/langgraph-cli`.
- `package.json`: `name` → `interface`; `dev` script runs Next only (drop
  `docker compose` + `langgraphjs dev`; backend runs separately).

## Environment

`.env.example` / `.env.local` — replace `LANGGRAPH_API_URL`,
`NEXT_PUBLIC_CAPTAIN_API_URL`, `LANGCHAIN_API_KEY`,
`NEXT_PUBLIC_LANGGRAPH_ASSISTANT_ID`, `NEXT_PUBLIC_LANGGRAPH_API_URL` with:

```
# Mastra credix backend (server-side only; browser talks to /api/chat)
CREDIX_API_URL=http://localhost:3000
```

## Reference updates (rename fallout)

- `.claude/skills/verify/SKILL.md` — `rahul-front` → `interface`.
- `README.md` — line ~394 roadmap entry.
- Historical logs (`tasks/progress.md`, `tasks/todo.md`) are left as-is (append-only log).
- Memory `feedback_commit_scope` mentions `rahul-front`; update after the rename lands.

## Error handling

- Proxy forwards upstream status; on fetch failure returns 502 `{ error }`.
- Adapter fails soft: timeout, abort, and non-2xx all produce user-facing text, never a
  blank message or an unhandled rejection.

## Testing / verification

- `cd interface && npx tsc --noEmit` (per the `verify` skill's frontend step, path
  updated to `interface`).
- Live smoke: start the Mastra Hono server (port 3000) + `next dev`; send a message
  through the real `/v1/chat`; confirm a coherent reply and that no PII (name/PAN/raw
  score context) leaks into the rendered text.

## Out of scope

- SSE token streaming (requires a streaming-aware guardrail).
- Voice/TTS delivery — the Orb / bar-visualizer stay as decorative UI only.
- OTP / real authentication; adding auth to `/v1/chat` (known backend gap, noted).

## Known gaps surfaced (not fixed here)

- `POST /v1/chat` is unauthenticated. The proxy leaves a seam, but adding real auth is
  a backend task tracked separately.
```
