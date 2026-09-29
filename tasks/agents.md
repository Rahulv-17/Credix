# Agent Activity Log

Running log of what each session did, what shipped, and what's staged/pending.
One section per session date. Newest first.

---

## 2026-06-25 — Issue 002 implementation

**Branch:** `dev`
**Status:** staged, not committed

### What was implemented

**Steps (`src/mastra/steps/`):**
- `decode.ts` — NFC normalize text; codepoint-based language detection (hi/gu/bn/ta/en);
  ElevenLabs Scribe v2 STT for audio path (`audio_url` → `result.text` + `result.language_code`)
- `pre-guardrail.ts` — injection + scope filter (fast, no I/O); bureau sidecar fetch on pass
  (`GET /internal/bureau/{user_id}` with `X-Internal-Token`); partial PII masking:
  mobile `98XXXX3210`, PAN `ABCXXXX34F`, Aadhaar `XXXXXXXX6666`; passes `decoded_text` downstream
- `post-guardrail.ts` — full PII redaction on LLM output; scrub order Aadhaar → PAN → mobile
  (avoids Aadhaar partial-match as two mobiles); regex reconstructed with `new RegExp(pattern.source, 'g')`
  on every call — prevents `lastIndex` bleed; CIBIL 3-digit scores preserved
- `compose.ts` — WhatsApp: strip markdown + truncate paragraphs to 3 lines; web: pass-through;
  tts: strip markdown + parentheticals → ElevenLabs TTS (`eleven_flash_v2_5`, `apply_text_normalization: 'on'`)
  → base64 `data:audio/mpeg;base64,<b64>`; voice from `ELEVENLABS_VOICE_ID` (default: George)

**Tools (`src/mastra/tools/`):**
- `calculators.ts` — `calculateEmi`: standard EMI formula, returns `"EMI: ${Math.round(emi)}"`;
  `calculateFoir`: guards `monthly_income <= 0` → error string (never throws); schema has no
  `.min()` on `monthly_income` so negative values reach `execute`
- `eligibility.ts` — kept as SKIP comment stub; blocked on `identityCheckStep` providing
  `bureau_profile` (Issue 003)

**Tests (`src/mastra/__tests__/`):**
- `steps.test.ts` — `mock.module('@elevenlabs/elevenlabs-js', ...)` for decode (audio path)
  and compose (tts); `fetch` mocked for pre-guardrail bureau call; `exec` helper wraps
  `step.execute({ inputData, mastra: null, getInitData: () => ({ mobile: '9876543210' }), getStepResult: () => undefined })`
- `tools.test.ts` — `execTool` helper: `tool.execute(inputData)` (bypasses `execute?:` optional
  typing); tests EMI, FOIR, and boundary cases

**Env:**
- `.env.example` — added `ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID`

**Package:**
- `@elevenlabs/elevenlabs-js` installed to `src/mastra/package.json` + `bun.lock` updated

### Verification

```
bun run typecheck   # exit 0
bun test            # 92 tests pass (53 patterns + steps + tools)
```

### Pending

- Commit with scope `agents` (per git-practices.md)
- Update `tasks/findings.md` with `lastIndex` double-call gap (noted in plan, not yet exercised by a test)
- Issue 003 is next: `understand.ts` (LLM call), `identity-check.ts` (bureau HTTP), `memory-writeback.ts`,
  `credix-workflow.ts` wiring

---

## 2026-06-24 — Issue 002 planning + Python sidecar rename

**Branch:** `dev`

### Jira + GitHub cross-link (start of session)

- Linked Jira issue **ZT-435** ("Setting up Mastra and specialized skill") to PR #4
  via a Jira comment (comment ID 15768) and patched the PR #4 body with the Jira URL.
  Used `gh api PATCH` workaround — `gh pr edit --body` fails with exit code 1 due to
  GitHub Projects (classic) deprecation.

### Issue 002 plan + grill session

- Read `issues/002-deterministic-steps-tools.md` (the spec for deterministic steps and tools).
- Entered plan mode and wrote `tasks/plan/plan-issue-002.md`.
- Ran a 12-round self-grill (adversarial review of the plan). One real defect found:

  **Round 2 defect — `Tool.execute` is optional in Mastra 1.45.0 types:**
  The tools test file as verbatim from the spec would fail `pnpm typecheck` with three
  simultaneous errors: `execute?:` is optional (can't call without `!`), `execute` expects
  a second `context` arg, and the return type `TSchemaOut | ValidationError | void` makes
  property access (`.tier`, `.result`) a type error. Fix: add `const execTool = (tool: any,
  inputData: any) => tool.execute(inputData)` helper at the top of `tools.test.ts`, mirroring
  the `exec` helper already in `steps.test.ts`.

- All other 11 rounds confirmed clean: import paths (`@mastra/core/workflows`,
  `@mastra/core/tools`) correct for 1.45.0; Zod 4.4.3 APIs all compatible; `lastIndex`
  regex fix is correct (but no test exercises the failure mode — noted for `findings.md`);
  `composeStep.session_id` threading is an Issue 004 concern only.

- User changed verification command: `pnpm test` → `bun test`, `pnpm typecheck` →
  `bun run typecheck`. Updated plan.

### Python sidecar rename: `credit_credix` → `nodes`

- `mv src/credit_credix src/nodes` — git detected 100+ renames correctly (`R` status).
- Removed `src/credit_credix.egg-info/` (stale, regenerates on `uv pip install -e .`).
- Updated `pyproject.toml`: `name = "credit-credix"` → `"nodes"`, updated description
  to reflect sidecar role.
- Updated 3 external files with absolute imports:
  - `scripts/resolve_profile.py` — 6 import lines
  - `src/nodes/api/routes/bureau_internal.py` — 2 import lines (now at new path)
  - `tests/unit/test_identity.py` — 2 import lines
- Two files (`llm/grok_client.py`, `raw_data/bureau/factory.py`) show as `A` (added)
  rather than `R` (renamed) because they were already tracked as working-tree deletions
  before the directory move. Content is intact.

### Mapping document

- Created `tasks/plan/nodes-to-mastra-mapping.md` — full mapping of every Python module
  in `src/nodes/` to its TypeScript counterpart in `src/mastra/`, grouped by:
  - Pipeline nodes (`graph/nodes/` → `steps/`)
  - Specialists (`graph/specialists/` → `agents/`)
  - Tools (`tools/decision_trees/`, `tools/deterministic_engine/` → `tools/`)
  - Guardrails → `lib/patterns.ts` + `steps/post-guardrail.ts`
  - Infrastructure (`api/` → `server.ts`)
  - Stays-Python-only (bureau resolver, memory store, observability, workers)
  - Cross-boundary invariants (mobile normalizer, Redis key format, numeric output rule)

**Staged, not committed.** Next: implement Issue 002 (write the 6 step/tool stubs +
2 test files), run `bun run typecheck` + `bun test`, then commit both this rename and
Issue 002 work together or as separate scoped commits.

---

## 2026-06-23 — Issue 001: Hono + Mastra bootstrap

**Branch:** `dev`  
**Commit:** `ebcee3d` — `infra: bootstrap Hono + Mastra layer, demote FastAPI to data sidecar — Issue 001`  
**PR:** #4 (open, linked to ZT-435)

### What shipped

**New TypeScript layer (`src/mastra/`):**
- `package.json` — ESM, `bun run typecheck` (`tsc --noEmit`), `bun test` (vitest);
  deps: `@mastra/core@1.45.0`, `@mastra/libsql`, `@mastra/memory`, `@ai-sdk/openai`,
  `hono`, `@hono/node-server`, `@hono/zod-validator`, `zod@4.4.3`
- `tsconfig.json` — `moduleResolution: "bundler"` (required for Mastra export maps),
  `strict: true`, `noEmit: true`
- `lib/provider.ts` — xAI Grok provider via `@ai-sdk/openai`, model from `LLM_MODEL`
- `lib/patterns.ts` — `INJECTION_PATTERNS` (8), `SCOPE_PATTERNS` (5), `PAN_PATTERN`,
  `AADHAAR_PATTERN`, `MOBILE_PATTERN`, `INTENT_VALUES`, `STEP_IDS` (11 constants).
  All regex read-only; steps reconstruct with `new RegExp` to avoid `lastIndex` bleed.
- `server.ts` — Hono on `$PORT`; startup guards for `INTERNAL_API_SECRET` and port
  2024 conflict; `POST /v1/chat` (calls Python sidecar for bureau data, returns stub
  response); `GET /health`
- `index.ts` — `LibSQLStore` + `Mastra` export (shared singleton; Issue 004 wires
  workflow + agents here)
- `steps/` — 8 comment-only stubs: decode, pre-guardrail, understand, identity-check,
  post-guardrail, memory-writeback, user-story, compose
- `agents/` — 4 comment-only stubs: credix, credit-card, insurance, score-improvement
- `tools/` — 3 comment-only stubs: bureau, eligibility, calculators
- `workflows/credix-workflow.ts` — comment-only stub with full pipeline outline

**Python sidecar hardened (`src/nodes/api/`):**
- `routes/bureau_internal.py` — added `GET /internal/bureau/{user_id}` and
  `GET /internal/bureau/{user_id}/{section}`; `resolve()` tuple unpack,
  `get_path()` list unwrap, `get_resolver().redis` singleton,
  `mobile_to_user_id()` normalization, `X-Internal-Token` auth
- `app.py` — swapped `chat.router` → `bureau_internal.router`
- `routes/chat.py` — deleted (broken import, superseded by Hono layer)

**Env + config:**
- `.env.example` — added `MASTRA_DB_URL`, `PORT`, `BUREAU_SIDECAR_URL`,
  `INTERNAL_API_SECRET`, `GROK_API_KEY`, `LLM_MODEL`

**Tracking:**
- `tasks/todo.md` — Issue 001 → complete, Issue 002 listed as next
- `tasks/findings.md` — `lastIndex` global regex caveat, `moduleResolution: "bundler"`
  requirement, `zValidator` middleware pattern, bureau sidecar URL contract
- `tasks/progress.md` — session entry written

### Verification at commit time
- `pnpm typecheck` — exit 0
- `ruff check src/nodes/api/` — clean

### Key decisions recorded
- FastAPI demoted to data-only sidecar; Hono is the public-facing API going forward.
- Python bureau resolver stays Python (Redis/Mongo/Snowflake) — TypeScript calls it via
  HTTP `X-Internal-Token` header. No port of the resolver logic in Issue 002.
- `mastra.getWorkflow('credix-workflow')` wiring deferred to Issue 004 to keep Issues
  002 and 003 focused on deterministic steps and LLM steps respectively.
