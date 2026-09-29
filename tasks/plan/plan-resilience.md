# Plan — Orchestration resilience (graceful failure)

## Goal

Close the three resilience gaps in the Mastra credix workflow so a transient
upstream failure degrades gracefully instead of 502-ing a user turn:

1. **Specialist agent LLM failure** currently throws → workflow `failed` → 502. It should
   retry transient errors, then fall back to a safe message (the same posture `understand`
   already has).
2. **Compose TTS failure** currently throws → a fully-reasoned, already-scrubbed answer is
   lost as a 502. It should fail soft: return the text and flag that audio was unavailable.
3. **No retry on `agent.generate`** — a transient Grok 5xx on the main reasoning call isn't
   retried before it fails.

Reuse the primitives already in the repo: `lib/retry.ts` (`withRetry`, 3 attempts, exp
backoff, 4xx fast-fail except 429) and `lib/errors.ts` (`AppError` + typed errors). No new
infrastructure. TDD: a failing test per failure path first, using the shared agent-mock
harness.

## Design decisions

- **Fallback vs surface:** for user-facing turns, prefer a graceful fallback over a 502 on
  *any* `agent.generate` failure (transient or not). The error is still recorded on the span
  and in logs, so ops/observability lose nothing; the user gets a coherent, retryable reply.
- **Retry then fallback:** wrap `agent.generate` in `withRetry` first (handles transient
  5xx/429), and only if it still throws do we return the fallback. `withRetry` already
  fast-fails true 4xx, so we don't waste attempts on a malformed request.
- **Observable degradation:** mirror `understand`'s `understand_error` marker. Add an optional
  `agent_error` to the agent output and a `tts_failed` flag to compose, both surfaced on spans.
- **Fail-soft compose contract:** when TTS fails, `composed` becomes the plain TTS-ready text
  (what we would have spoken) and `tts_failed: true` propagates to the HTTP response so the
  client can render text or do client-side TTS. The turn is a `success`, not a 502.
- **No behavior change on the happy path** — every existing test must stay green.

## Phases

### Phase R1 — Specialist agent retry + fallback (covers weaknesses 1 and 3) `pending`

Location: `makeAgentStep` in `workflows/credix-workflow.ts`; schema in the same file.

- [ ] **Test first** (`__tests__/workflow.test.ts`, via the shared `agent-mock.ts` harness,
      dynamic import after `mock.module`):
  - transient 5xx then success → normal response, retried, no fallback marker.
  - `generate` throws on every attempt → workflow status `success`, response is the safe
    fallback message, `active_skill` preserved, `agent_error` set; the reply still flows
    through post-guardrail + compose.
  - guardrail-reject path unchanged (still no LLM call).
- [ ] **Implement:**
  - wrap the `agent.generate(...)` call in `withRetry(() => agent.generate(...), \`agent:${id}\`)`.
  - replace the `catch { recordError; throw }` with `catch → return fallback AgentOutput`
    (`raw_response` = safe retryable message, `tool_calls_log: []`, `active_skill: id`,
    `agent_error: <code>`); still `recordError` on the span and set `app.agent.error`.
  - add `agent_error: z.string().optional()` to `agentOutputSchema`; carry it through the
    `firedBranch` collapse so it's observable downstream.
- Safe message (PII-free, retryable): "I hit a snag putting that together. Please try again in a moment."

### Phase R2 — Fail-soft compose on TTS failure (covers weakness 2) `pending`

Location: `steps/compose.ts`; output schema there + `workflowOutput` in the workflow +
`/v1/chat` response in `server.ts`.

- [ ] **Test first** (`__tests__/steps.test.ts` or a focused compose test):
  - channel `tts`, `toTtsAudio` mocked to throw `TTSError` → step resolves (no throw),
    `composed` === plain TTS text, `tts_failed: true`.
  - channel `tts`, success → audio `data:` URI, `tts_failed: false`.
  - channels `web` / `whatsapp` → unchanged, `tts_failed: false`.
- [ ] **Implement:**
  - `try { composed = await toTtsAudio(ttsText) } catch (TTSError) { composed = ttsText; tts_failed = true }`
    (only swallow `TTSError`; a config error like a missing key can still surface if desired —
    decide in impl, default: also fail soft to text).
  - extend compose `outputSchema` with `tts_failed: z.boolean().default(false)`.
  - thread `tts_failed` through `workflowOutput` and the `/v1/chat` success response.
  - record `app.compose.tts_failed` on the span.

### Phase R3 — Wire-through + full verification `pending`

- [ ] Update the `/v1/chat` success payload to include `tts_failed` (and keep `active_skill`).
- [ ] E2E test (`__tests__/e2e.test.ts`, mocked): a full run where the agent fails →
      200 with the fallback text; a full `tts` run where TTS fails → 200 with text + `tts_failed`.
- [ ] `bunx tsc --noEmit -p src/mastra/tsconfig.json` exit 0.
- [ ] `bun test` green (163 pass baseline + new tests, 0 fail).
- [ ] Update `tasks/progress.md`; commit per phase (`middleware:`/`api:` scope, no dash separators).

### Phase R4 — (optional) harden the `firedBranch` seam `pending`

- [ ] Make `firedBranch` assert exactly one non-null branch result (or derive its list from
      `STEP_IDS`), so adding a specialist can't silently break the collapse. Test: two branches
      set → throws; zero set → clear error. Low priority; skip if time-boxed.

## Test harness notes (from lessons.md — do not relearn)

- `bun mock.module` is NOT hoisted above static `import` and only intercepts **bare**
  specifiers. Mock `@mastra/core/agent` via the shared `__tests__/agent-mock.ts`, then
  **dynamically `await import(...)`** the workflow/module under test AFTER the mock registers.
- The stub `Agent` must **extend** the real `Agent` (registration calls `__setLogger`, etc.).
- Drive `generate` via the harness's mutable state; to simulate failure, make that state throw.
- `mastra.getWorkflow('credixWorkflow')` uses the **registration key**, not the workflow id.

## Files touched

| File | Change |
|------|--------|
| `workflows/credix-workflow.ts` | retry + fallback in `makeAgentStep`; `agent_error` in schema; carry through `firedBranch`; `tts_failed` in `workflowOutput` + Seam 2 map |
| `steps/compose.ts` | try/catch fail-soft TTS; `tts_failed` in output schema; span attr |
| `server.ts` | surface `tts_failed` in the `/v1/chat` success response |
| `__tests__/workflow.test.ts` | agent retry + fallback tests |
| `__tests__/steps.test.ts` | compose fail-soft tests |
| `__tests__/e2e.test.ts` | end-to-end degraded-path tests |
| `lib/errors.ts` | reused as-is (no new error type expected) |
| `lib/retry.ts` | reused as-is |

## Risks / watch-outs

- **Schema propagation:** adding `tts_failed`/`agent_error` means updating every schema seam
  (branch output, `firedBranch`, `workflowOutput`, compose input/output, server response) or
  Mastra's branch-invariant validation fails. Change all seams in the same phase.
- **Over-swallowing:** don't let the fallback hide a genuine config error silently — always
  `recordError` + log with the code so a broken key is still visible in traces.
- **Don't retry inside a retry:** the ElevenLabs calls already use `withRetry`; only the
  specialist `agent.generate` needs wrapping. Don't double-wrap compose's TTS.
- **Happy path unchanged:** all 163 existing tests must stay green.

## Verification (definition of done)

- New tests fail before the change, pass after (TDD).
- `tsc` exit 0; `bun test` 0 fail.
- A manual/mocked run proves: agent failure → graceful text reply (not 502); TTS failure →
  text reply + `tts_failed` (not 502).

## Errors encountered

| When | Error | Resolution |
|------|-------|------------|
| — | — | — |
