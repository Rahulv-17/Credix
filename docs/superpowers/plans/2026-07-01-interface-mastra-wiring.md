# Interface → Mastra Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename `rahul-front/` to `interface/` and wire it end-to-end to the Mastra `credixWorkflow` at `POST /v1/chat`, replacing the dead LangGraph/"captain" wiring.

**Architecture:** The browser talks only to a same-origin Next.js proxy (`/api/chat`), which forwards to the Hono backend (`CREDIX_API_URL`, default `http://localhost:3000`). A `useLocalRuntime` adapter POSTs `{ mobile, message, session_id, channel }` and renders the single JSON `response` (client typewriter). Onboarding is phone-capture-only; `session_id` is backend-owned and persisted in localStorage.

**Tech Stack:** Next.js 16, React 19, `@assistant-ui/react` (`useLocalRuntime`), TypeScript. Backend: Hono `POST /v1/chat` (unchanged).

## Global Constraints

- No CORS on the backend → the browser MUST go through the Next.js proxy; never fetch `/v1/chat` directly from a component. (spec: Verified backend contract)
- `/v1/chat` request body is exactly `{ mobile: string≥10, message: string≥1, session_id?: string, channel: 'web'|'whatsapp'|'tts' }`; the frontend always sends `channel: 'web'`. (spec: Verified backend contract)
- Success + `not_found` both return HTTP 200 with a user-facing `response`; render `response` whenever present. (spec: Verified backend contract)
- `CREDIX_API_URL` is server-side only (used in the Next route handler); never expose it with a `NEXT_PUBLIC_` prefix. (spec: Environment)
- Single request/response only — no token streaming (PII redaction happens in `postGuardrailStep`; streaming would bypass it). (spec: Decisions)
- No new test framework in `interface/`; verification is `cd interface && npx tsc --noEmit` plus a live smoke. (spec: Testing/verification)
- No real names on the client (PII-stripped upstream); greetings stay generic. (spec: Architecture §3)

---

## File Structure

- `interface/` — renamed from `rahul-front/` (untracked; plain `mv`).
- `interface/app/api/chat/route.ts` — NEW. Server-side POST proxy to `${CREDIX_API_URL}/v1/chat`.
- `interface/app/api/[..._path]/route.ts` — DELETE. Old LangGraph proxy.
- `interface/lib/auth.ts` — NEW. Shared `AuthState` type.
- `interface/lib/useCredixRuntime.ts` — NEW. `useLocalRuntime` adapter over `/api/chat`.
- `interface/lib/useCustomLangGraphRuntime.ts` — DELETE.
- `interface/lib/chatApi.ts` — DELETE.
- `interface/app/assistant.tsx` — MODIFY. Use new runtime + `AuthState`; drop thread mgmt.
- `interface/components/ui/phone-input-screen.tsx` — MODIFY. Phone capture only; seed intro via `/api/chat`.
- `interface/components/gemini.tsx` — MODIFY (1 line). "New conversation" clears the session key.
- `interface/backend/agent.ts` + `interface/backend/` — DELETE.
- `interface/langgraph.json` — DELETE.
- `interface/package.json` — MODIFY. `name`, `dev` script, remove LangGraph deps.
- `interface/.env.example`, `interface/.env.local` — MODIFY. `CREDIX_API_URL`.
- `.claude/skills/verify/SKILL.md`, `README.md` — MODIFY. `rahul-front` → `interface`.

---

### Task 1: Rename the directory and fix live references

No behavior change. The tree still contains the old LangGraph code and still typechecks unchanged.

**Files:**
- Rename: `rahul-front/` → `interface/`
- Modify: `.claude/skills/verify/SKILL.md` (lines ~27, ~29)
- Modify: `README.md` (line ~394)

**Interfaces:**
- Produces: an `interface/` directory that typechecks as-is (baseline for later tasks).

- [ ] **Step 1: Rename the directory**

```bash
cd /home/beast/Documents/Com/Credix
mv rahul-front interface
```

- [ ] **Step 2: Update the verify skill path**

In `.claude/skills/verify/SKILL.md`, replace both occurrences of `rahul-front` with `interface` (the heading `### Frontend (Next.js / rahul-front/)` and the command `cd rahul-front && npx tsc --noEmit`).

- [ ] **Step 3: Update the README roadmap line**

In `README.md` line ~394, change `` `rahul-front` Next.js UI integration `` to `` `interface/` Next.js UI integration ``.

- [ ] **Step 4: Verify the renamed tree still typechecks**

Run: `cd /home/beast/Documents/Com/Credix/interface && npx tsc --noEmit`
Expected: exit 0 (code is unchanged from before the rename).

- [ ] **Step 5: Commit**

```bash
cd /home/beast/Documents/Com/Credix
git add interface .claude/skills/verify/SKILL.md README.md
git commit -m "frontend: rename rahul-front to interface; update live references

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Add the Next.js proxy, delete the LangGraph proxy, set env

**Files:**
- Create: `interface/app/api/chat/route.ts`
- Delete: `interface/app/api/[..._path]/route.ts`
- Modify: `interface/.env.example`, `interface/.env.local`

**Interfaces:**
- Produces: same-origin `POST /api/chat` → forwards JSON body to `${CREDIX_API_URL}/v1/chat`, returns upstream status + JSON; 502 `{ error, detail }` if the backend is unreachable.

- [ ] **Step 1: Create the proxy route**

Create `interface/app/api/chat/route.ts`:

```ts
import { type NextRequest, NextResponse } from "next/server";

// Server-side only. The browser never sees this URL; it always calls /api/chat.
const CREDIX_API_URL =
  process.env.CREDIX_API_URL || "http://localhost:3000";

// Node runtime (not edge) so we can reach an internal backend host.
export async function POST(req: NextRequest) {
  try {
    const body = await req.text();
    const res = await fetch(`${CREDIX_API_URL}/v1/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: req.signal,
    });
    const text = await res.text();
    return new NextResponse(text, {
      status: res.status,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    const detail = e instanceof Error ? e.message : "unknown";
    return NextResponse.json(
      { error: "Credix backend unreachable", detail },
      { status: 502 },
    );
  }
}
```

- [ ] **Step 2: Delete the old LangGraph proxy**

```bash
cd /home/beast/Documents/Com/Credix
rm -rf "interface/app/api/[..._path]"
```

- [ ] **Step 3: Rewrite env files**

Replace the entire contents of `interface/.env.example`:

```
# Mastra credix backend. Server-side only (used by app/api/chat/route.ts).
# The browser talks to the same-origin /api/chat proxy, never this URL directly.
CREDIX_API_URL=http://localhost:3000
```

Replace the entire contents of `interface/.env.local`:

```
# Mastra credix backend (Hono POST /v1/chat), default port 3000.
CREDIX_API_URL=http://localhost:3000
```

- [ ] **Step 4: Typecheck**

Run: `cd /home/beast/Documents/Com/Credix/interface && npx tsc --noEmit`
Expected: exit 0. (The old runtime files still exist and still compile; they're removed in Task 3.)

- [ ] **Step 5: Smoke the proxy against a running backend (optional but recommended)**

In one shell: `cd /home/beast/Documents/Com/Credix/src/mastra && pnpm dev` (Hono on :3000).
In another: `cd /home/beast/Documents/Com/Credix/interface && npm run dev` then:

Run: `curl -s -X POST http://localhost:3000/health` → Expected: `{"ok":true}`
Run: `curl -s -X POST http://localhost:3000/v1/chat -H 'Content-Type: application/json' -d '{"mobile":"123","message":"hi"}'`
Expected: HTTP 400 `{"error":"Invalid mobile number — must resolve to 10 digits"}` (confirms the contract; a real 10-digit registered number returns `{response,session_id,active_skill}`).

- [ ] **Step 6: Commit**

```bash
cd /home/beast/Documents/Com/Credix
git add interface/app/api/chat/route.ts interface/.env.example interface/.env.local
git add -A interface/app/api
git commit -m "frontend: add /api/chat proxy to Mastra backend; drop LangGraph proxy

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Swap the runtime and rewire auth (atomic — must land together)

Runtime + `AuthState` shape + phone screen change together; splitting would break `tsc` mid-way because `assistant.tsx` and `phone-input-screen.tsx` share the `AuthState` type.

**Files:**
- Create: `interface/lib/auth.ts`
- Create: `interface/lib/useCredixRuntime.ts`
- Delete: `interface/lib/useCustomLangGraphRuntime.ts`, `interface/lib/chatApi.ts`
- Modify: `interface/app/assistant.tsx`
- Modify: `interface/components/ui/phone-input-screen.tsx`
- Modify: `interface/components/gemini.tsx` (1 line)

**Interfaces:**
- Produces: `AuthState = { mobile: string; sessionId: string }` (from `lib/auth.ts`); `useCredixRuntime(mobile: string, sessionId: string)` returning an assistant-ui runtime.
- Consumes: `POST /api/chat` from Task 2.

- [ ] **Step 1: Create the shared auth type**

Create `interface/lib/auth.ts`:

```ts
export interface AuthState {
  mobile: string;
  sessionId: string;
}
```

- [ ] **Step 2: Create the credix runtime**

Create `interface/lib/useCredixRuntime.ts`:

```ts
import { useLocalRuntime, type ChatModelAdapter } from "@assistant-ui/react";
import { useMemo, useRef } from "react";

const SESSION_KEY = "credix_session_id";
const REQUEST_TIMEOUT_MS = 60_000;

interface ChatResponse {
  response?: string;
  session_id?: string;
  active_skill?: string;
  error?: string;
  detail?: string;
}

export function useCredixRuntime(mobile: string, sessionId: string) {
  const mobileRef = useRef(mobile);
  mobileRef.current = mobile;
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  const adapter = useMemo<ChatModelAdapter>(
    () => ({
      async *run({ messages, abortSignal }) {
        const latest = messages[messages.length - 1];
        if (!latest || latest.role !== "user") return;

        const content = latest.content
          .map((c) => (c.type === "text" ? c.text : ""))
          .join("");

        // Prefer the backend-issued session id if we have one persisted.
        const stored =
          typeof window !== "undefined"
            ? localStorage.getItem(SESSION_KEY)
            : null;
        const session_id = stored || sessionIdRef.current;

        const timeoutCtrl = new AbortController();
        const timer = setTimeout(
          () => timeoutCtrl.abort(),
          REQUEST_TIMEOUT_MS,
        );
        const onAbort = () => timeoutCtrl.abort();
        abortSignal?.addEventListener("abort", onAbort);

        try {
          const res = await fetch("/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              mobile: mobileRef.current,
              message: content,
              session_id,
              channel: "web",
            }),
            signal: timeoutCtrl.signal,
          });

          const data = (await res
            .json()
            .catch(() => ({}))) as ChatResponse;

          // Success and not_found both return 200 with a user-facing response.
          if (res.ok && data.response) {
            if (data.session_id && typeof window !== "undefined") {
              localStorage.setItem(SESSION_KEY, data.session_id);
            }
            yield {
              content: [{ type: "text" as const, text: data.response }],
            };
            return;
          }

          const text =
            res.status === 502
              ? "I'm having trouble reaching your data right now. Please try again in a moment."
              : data.error || "Something went wrong. Please try again.";
          yield { content: [{ type: "text" as const, text }] };
        } catch (err) {
          // User-initiated abort: assistant-ui already handles it — stay silent.
          if (abortSignal?.aborted) return;
          const timedOut = (err as Error)?.name === "AbortError";
          yield {
            content: [
              {
                type: "text" as const,
                text: timedOut
                  ? "That took too long. Please try again."
                  : "I'm having trouble connecting right now.",
              },
            ],
          };
        } finally {
          clearTimeout(timer);
          abortSignal?.removeEventListener("abort", onAbort);
        }
      },
    }),
    [], // stable — live values via refs
  );

  return useLocalRuntime(adapter);
}
```

- [ ] **Step 3: Rewrite `assistant.tsx`**

Replace the entire contents of `interface/app/assistant.tsx`:

```tsx
"use client";

import { useState, useEffect } from "react";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { Gemini } from "@/components/gemini";
import { useCredixRuntime } from "@/lib/useCredixRuntime";
import type { AuthState } from "@/lib/auth";
import { PhoneInputScreen } from "@/components/ui/phone-input-screen";

const AUTH_KEY = "credix_auth";
const SESSION_KEY = "credix_session_id";

function getStoredAuth(): AuthState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(AUTH_KEY);
    return raw ? (JSON.parse(raw) as AuthState) : null;
  } catch {
    return null;
  }
}

function storeAuth(auth: AuthState) {
  if (typeof window === "undefined") return;
  localStorage.setItem(AUTH_KEY, JSON.stringify(auth));
}

function clearAuth() {
  if (typeof window === "undefined") return;
  localStorage.removeItem(AUTH_KEY);
  localStorage.removeItem(SESSION_KEY);
}

// Hooks live here so they're never called conditionally.
function AuthenticatedApp({ auth }: { auth: AuthState }) {
  const runtime = useCredixRuntime(auth.mobile, auth.sessionId);
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Gemini />
    </AssistantRuntimeProvider>
  );
}

export function Assistant() {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const stored = getStoredAuth();
    if (stored) setAuth(stored);
    setMounted(true);
  }, []);

  function handleVerified(newAuth: AuthState) {
    storeAuth(newAuth);
    setAuth(newAuth);
  }

  // Exposed for a future sign-out control; keeps clearAuth referenced.
  void clearAuth;

  if (!mounted) return null;
  if (!auth) return <PhoneInputScreen onVerified={handleVerified} />;
  return <AuthenticatedApp auth={auth} />;
}
```

- [ ] **Step 4: Update the "new conversation" button in `gemini.tsx`**

In `interface/components/gemini.tsx`, inside `NewThreadButton`'s `onClick`, replace:

```tsx
        localStorage.removeItem("captain_thread_id");
```

with:

```tsx
        localStorage.removeItem("credix_session_id");
```

- [ ] **Step 5: Rewire `phone-input-screen.tsx` — imports and AuthState**

In `interface/components/ui/phone-input-screen.tsx`:

Add near the other imports:

```tsx
import type { AuthState } from "@/lib/auth";
```

Delete the local `AuthState` interface block:

```tsx
export interface AuthState {
  userToken: string;
  sessionId: string;
  firstName: string;
}
```

Delete the captain API constant:

```tsx
const CAPTAIN_API =
  process.env.NEXT_PUBLIC_CAPTAIN_API_URL || "http://localhost:8080";
```

- [ ] **Step 6: Rewire `phone-input-screen.tsx` — summary text (drop firstName)**

Replace:

```tsx
  const summaryText = authData ? `Hey ${authData.firstName}! This is Rahul I am personalized by your choices and preferences, i will help you manage your finances, if you had a personal advisor well it sounds like someone is going to lose their job` : "";
```

with:

```tsx
  const summaryText = authData ? `Hey! This is Rahul, personalized by your choices and preferences. I'll help you manage your finances.` : "";
```

- [ ] **Step 7: Rewire `phone-input-screen.tsx` — `onSubmit` (phone capture only)**

Replace the whole `onSubmit` function:

```tsx
  const onSubmit = async (data: FormData) => {
    if (loading) return;
    setLoading(true);
    setStage("authenticating");
    setApiError("");

    try {
      const res = await fetch(`${CAPTAIN_API}/api/v1/auth/verify-mobile`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mobile: data.phone.replace(/\D/g, "").slice(-10) }),
      });
      const responseData = await res.json();

      if (!res.ok || !responseData.verified) {
        setApiError(responseData.error || "Couldn't verify that number. Try again.");
        setLoading(false);
        setStage("input");
        return;
      }

      const verifiedAuth = {
        userToken: responseData.user_token,
        sessionId: responseData.session_id,
        firstName: responseData.first_name,
      };
      setAuthData(verifiedAuth);

      setStage("fetching-profile");
      const profileRes = await fetch(`${CAPTAIN_API}/api/v1/user/profile/${verifiedAuth.userToken}`);
      const profileJson = await profileRes.json();

      if (profileRes.ok) {
        setProfileData(profileJson);
      }

      setLoading(false);
      setStage("gliding");

    } catch {
      setApiError("Connection error. Make sure the server is running.");
      setLoading(false);
      setStage("input");
    }
  };
```

with:

```tsx
  const onSubmit = async (data: FormData) => {
    if (loading) return;
    setLoading(true);
    setStage("authenticating");
    setApiError("");

    const mobile = data.phone.replace(/\D/g, "").slice(-10);
    if (mobile.length !== 10) {
      setApiError("Please enter a valid 10-digit mobile number.");
      setLoading(false);
      setStage("input");
      return;
    }

    const verifiedAuth: AuthState = { mobile, sessionId: crypto.randomUUID() };
    setAuthData(verifiedAuth);
    // No profile fetch (PII stays server-side); mark ready so the summary stage renders.
    setProfileData({ ready: true });

    setStage("fetching-profile");
    setLoading(false);
    setStage("gliding");
  };
```

- [ ] **Step 8: Rewire `phone-input-screen.tsx` — intro message 1 (real seed call)**

Replace the intro-message-1 fetch block:

```tsx
            fetch(`${CAPTAIN_API}/api/v1/user/intro-message-1/${authData.userToken}`)
              .then(res => res.json())
              .then(data => {
                if (data.message) {
                  setMsg1Full(data.message);
                }
              })
              .catch(console.error);
```

with:

```tsx
            fetch("/api/chat", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                mobile: authData.mobile,
                message:
                  "Introduce yourself in one short, friendly line and mention one thing you notice about my finances.",
                session_id: authData.sessionId,
                channel: "web",
              }),
            })
              .then((res) => res.json())
              .then((data) => {
                setMsg1Full(
                  data.response ||
                    "Hey! I'm Rahul, your personal finance credix. Let's take a look at your money together.",
                );
              })
              .catch(() =>
                setMsg1Full(
                  "Hey! I'm Rahul, your personal finance credix. Let's take a look at your money together.",
                ),
              );
```

- [ ] **Step 9: Rewire `phone-input-screen.tsx` — intro message 2 (static)**

Replace the intro-message-2 fetch effect body:

```tsx
      // Fire fetch immediately in background when stage starts
      fetch(`${CAPTAIN_API}/api/v1/user/intro-message-2/${authData.userToken}`)
        .then(res => res.json())
        .then(data => {
          if (data.message) {
            setMsg2Full(data.message);
          }
        })
        .catch(console.error);
```

with:

```tsx
      // Static tagline — no second network call.
      setMsg2Full(
        "I'm personalized to your choices and preferences. Ask me anything about your finances whenever you're ready.",
      );
```

- [ ] **Step 10: Delete the dead runtime files**

```bash
cd /home/beast/Documents/Com/Credix
rm interface/lib/useCustomLangGraphRuntime.ts interface/lib/chatApi.ts
```

- [ ] **Step 11: Typecheck**

Run: `cd /home/beast/Documents/Com/Credix/interface && npx tsc --noEmit`
Expected: exit 0. If it errors on a stray `authData.firstName` / `authData.userToken` / `CAPTAIN_API` reference, remove that reference (all name/token usages are replaced above).

- [ ] **Step 12: Commit**

```bash
cd /home/beast/Documents/Com/Credix
git add interface/lib interface/app/assistant.tsx interface/components/ui/phone-input-screen.tsx interface/components/gemini.tsx
git commit -m "frontend: swap LangGraph runtime for /api/chat adapter; phone-capture onboarding

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Remove dead LangGraph deps and files

**Files:**
- Modify: `interface/package.json`
- Delete: `interface/backend/agent.ts` (+ `interface/backend/`), `interface/langgraph.json`

**Interfaces:**
- Consumes: nothing new. Produces a dependency tree with no LangChain/LangGraph packages.

- [ ] **Step 1: Delete the LangGraph backend files**

```bash
cd /home/beast/Documents/Com/Credix
rm -rf interface/backend interface/langgraph.json
```

- [ ] **Step 2: Edit `package.json`**

In `interface/package.json`:

Change `"name": "rahul-front"` to `"name": "interface"`.

Replace the `dev` script:

```json
    "dev": "docker compose -f ../docker-compose.yml up -d && next dev --turbopack",
```

with:

```json
    "dev": "next dev --turbopack",
```

Delete the `dev:backend` script line:

```json
    "dev:backend": "langgraphjs dev",
```

Remove these `dependencies`: `@assistant-ui/react-langgraph`, `@langchain/anthropic`, `@langchain/langgraph`, `@langchain/langgraph-sdk`.

Remove these `devDependencies`: `@langchain/core`, `@langchain/langgraph-cli`, `concurrently`.

- [ ] **Step 3: Reinstall to refresh the lockfile**

Run: `cd /home/beast/Documents/Com/Credix/interface && npm install`
Expected: completes; `package-lock.json` updated, LangGraph packages gone.

- [ ] **Step 4: Grep for any lingering LangGraph imports**

Run: `cd /home/beast/Documents/Com/Credix/interface && grep -rn "langchain\|langgraph\|react-langgraph" app lib components --include="*.ts" --include="*.tsx"`
Expected: no output. If any hit remains, remove that import/usage.

- [ ] **Step 5: Typecheck**

Run: `cd /home/beast/Documents/Com/Credix/interface && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
cd /home/beast/Documents/Com/Credix
git add interface/package.json interface/package-lock.json
git add -A interface/backend interface/langgraph.json
git commit -m "frontend: drop LangGraph deps and dead backend graph from interface

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Live end-to-end smoke and session notes

**Files:**
- Modify: `tasks/progress.md`, `tasks/todo.md`
- Modify: memory `feedback_commit_scope.md` (+ `MEMORY.md` pointer if wording changes)

**Interfaces:**
- Consumes: everything above. Produces: a verified running system + updated logs.

- [ ] **Step 1: Start both servers**

Backend: `cd /home/beast/Documents/Com/Credix/src/mastra && pnpm dev` (Hono on :3000; requires `GROK_API_KEY`, `INTERNAL_API_SECRET`, and the Python bureau sidecar running).
Frontend: `cd /home/beast/Documents/Com/Credix/interface && npm run dev` (Next on :3001 or the printed port — it must NOT collide with 3000).

- [ ] **Step 2: Drive the UI**

Open the Next dev URL. Enter a real registered 10-digit mobile. Confirm: the intro animation plays, the first intro bubble is a real Rahul line (from `/api/chat`), then the chat opens. Send "How's my credit score?" and confirm a coherent reply.

- [ ] **Step 3: PII-safety check**

In the reply text and the browser Network tab (`/api/chat` response), confirm no raw PAN, no full name, and that numbers render as digits. Expected: only PII-stripped, guardrail-passed content.

- [ ] **Step 4: Error-path check**

Stop the backend, send a message. Expected: the bubble reads "I'm having trouble reaching your data right now…" (proxy 502 path), not a blank bubble or a crash.

- [ ] **Step 5: Update task logs**

Append a dated entry to `tasks/progress.md` describing the wiring + smoke results. In `tasks/todo.md`, add a completed phase entry for the interface integration and update the README roadmap line 394 status from `planned` to `done` if the smoke passed.

- [ ] **Step 6: Update memory**

Update `~/.claude/projects/-home-beast-Documents-Com-Credix/memory/feedback_commit_scope.md` so the "never commit rahul-front/" note reflects the rename to `interface/` (or that it is now an integrated, committable app if that decision is made). Adjust the `MEMORY.md` pointer line if the hook text changes.

- [ ] **Step 7: Commit**

```bash
cd /home/beast/Documents/Com/Credix
git add tasks/progress.md tasks/todo.md README.md
git commit -m "docs: log interface<->Mastra end-to-end wiring and smoke results

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Directory rename → Task 1.
- Next proxy (mandatory, no CORS) → Task 2.
- `useCredixRuntime` adapter (abort/timeout/error copy, session persistence) → Task 3 Step 2.
- Phone-capture onboarding + seed intro (first bubble real, second static) → Task 3 Steps 5-9.
- Session continuity via localStorage `credix_session_id` → Task 3 (runtime + gemini + assistant).
- Dep/env cleanup → Task 4 + Task 2 Step 3.
- Reference updates (verify skill, README) → Task 1; memory → Task 5.
- Verification (tsc + live smoke + PII check) → each task's typecheck + Task 5.
- Out of scope (SSE, voice, OTP) → not implemented.

**Placeholder scan:** No TBD/TODO; every code step shows complete code. The `{ ready: true }` profile flag is intentional (drives the existing `stage === "personalized-summary" && profileData` gate without a profile fetch).

**Type consistency:** `AuthState = { mobile, sessionId }` defined in `lib/auth.ts` (Task 3 Step 1), consumed identically in `assistant.tsx` (Step 3), `phone-input-screen.tsx` (Steps 5, 7), and `useCredixRuntime(mobile, sessionId)` (Step 2). Session key `credix_session_id` is identical across runtime, `assistant.tsx`, and `gemini.tsx`. Request body matches the verified `chatSchema` exactly.
