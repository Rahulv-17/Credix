# Turn latency: cut 15-18s turns to ~9-11s (production fix)

## Context

Honeycomb traces from 2026-07-07 (two 3-turn probe sessions + 48h aggregates over 13 workflow turns, service `credix-mastra`, env `test`) show every turn pays the same serial cost regardless of turn number; the bureau in-process cache (commit 08e74d5) only saves ~50ms on turn 2+. Three confirmed drains:

1. **`understand.classify` = 5.24s avg, every turn, fully serial.** One grok-3 POST (verified: Mastra structuredOutput without `model` is "direct" mode, native json_schema response_format, no second structuring call). The cost is output-token-bound: the brief (summary + 2-5 points) is ~100-200 output tokens vs ~8 for intent-only. The earlier grok-4.3 → grok-3 swap proved model tier is not the driver (lessons.md).
2. **Exa grounding = ~726ms serial prefetch inside `agent.generate`** before the 7.5-10s main x.ai call, though it only needs the user message.
3. **17 main x.ai POSTs across 13 turns** — specialists still tool-call `getBureauProfile` despite the full masked profile being injected in the prompt (each = one extra LLM round-trip). Plus fresh TLS to api.exa.ai every turn (undici default keepAliveTimeout 4s < inter-turn gap).

User decisions (2026-07-08): drop the brief entirely (intent-only classification); keep grounding on all substantive turns, parallelized with classification.

Expected turn shape after: `max(classify ~1-2s, exa ~0.7s) + generate 7.5-10s ≈ 9-11s`, one x.ai POST/turn.

Takes over the `not_started` todo phase "Latency (RE-OPENED after real multi-turn trace)". **Take a baseline multi-turn probe trace before Phase A.**

## Phase A — intent-only classification (drop the brief)

File: `src/mastra/steps/understand.ts`

- `llmSchema` → `z.object({ intent: z.enum(INTENT_VALUES) })` (flat — smaller strict-mode grammar).
- `SYSTEM_PROMPT` → pure 5-way classification; drop the brief instructions and "Think before answering".
- `structuredOutput.fallbackValue` → `{ intent: 'general' }`; delete `fallbackBrief`; drop `brief` from all three return paths (success, `llm_<status>`, `llm_unreachable`).
- Drop the `providerOptions.openai.reasoningEffort` line — no-op on grok-3, noise in before/after traces.
- KEEP `briefSchema` + optional `brief` in `understandOutputSchema` (branch invariant, zero churn, trivially revertable).
- `workflows/credix-workflow.ts` makeAgentStep: remove the now-dead `points` prompt block and `brief` read.
- `lib/web-grounding.ts`: `buildQuery` loses the brief param — query is the raw message.

Tests: `__tests__/understand.test.ts` — rewrite `okObject` helper + 3 brief assertions (lines ~68/95/103) to assert `brief` is `undefined` and intent/degradation markers survive; clean up `workflow.test.ts`/`e2e.test.ts` mocks that return `{intent, brief}`.

Fallbacks if the probe shows classify still ~5s (then it's TTFB/grammar-compile on xAI's side, not tokens):
1. Restore the direct `chat.completions` fetch with `response_format: {type:'json_object'}` from git `59153fe:src/mastra/steps/understand.ts` (pre-004.1 impl, degradation contract already written).
2. Belt-and-braces: `modelSettings: { maxOutputTokens: 16 }` on the generate call (supported in @mastra/core 1.45.0).

## Phase B — parallelize grounding with classification

Files: `src/mastra/steps/understand.ts`, `lib/web-grounding.ts`, `workflows/credix-workflow.ts`

- In `understandStep.execute` (guardrail short-circuit unchanged, zero Exa/LLM on blocked): start the grounding promise BEFORE entering the classify span, wrapped in its own `web.grounding` span carrying the `app.web_grounding.*` attributes — `understand.classify` must keep measuring only the LLM call (lessons.md: per-span durations are the verification currency). Then `Promise.all`.
- `groundWithWeb(decoded_text, span)` — drop intent/brief params; keep greeting/length gate. The `bureau_query` skip becomes a discard-after-classify on the success path only (degraded paths force 'general', so they keep the context).
- Attach `web_context` on ALL THREE return paths (success + both degraded paths — a degraded turn routes to general and still benefits).
- `understandOutputSchema` += `web_context: z.string().optional()`. Verified safe across every seam: guardrailRejectStep ignores it, branch conditions read only pre_guardrail/intent, seam-1 .map() intentionally drops it, seam 2 / compose untouched. `web_context` in `captureOutput` is third-party web text behind the existing `OTEL_CAPTURE_IO` opt-in — no new PII class.
- makeAgentStep: replace `await groundWithWeb(...)` + import with `inputData.web_context ?? ''`.

Tests:
- **Env leak guard**: bun auto-loads `.env`; add `delete process.env.EXA_API_KEY` in `beforeAll` of understand/workflow/e2e tests so unit tests never hit the live Exa API (fail-soft path returns '').
- New: web_context present when grounding yields text (mock `exa-js` — bare specifier, client lazily memoized, mockable per lessons.md); discarded for bureau_query; grounding failure leaves classification unaffected; guardrail short-circuit makes zero Exa calls; specialist prompt contains "Live web context" when emitted.

## Phase C — remove redundant getBureauProfile from specialists

Files: `agents/score-improvement.ts`, `agents/credit-card.ts`, `agents/credix.ts` (insurance has none)

- Remove `getBureauProfile` from imports + `tools` maps. Keep `getBureauDetail` (covers all 8 sections incl. `general_info` — real recovery path for anything the allowlist mask omits), `exaSearch`, `getStatement`, `checkCardEligibility`.
- Safe: server.ts fetches bureau first (502 on transport failure, early-return on not_found) — workflow never runs without a profile; makeAgentStep injects the identical masked payload.
- Keep the `tools/bureau.ts` export + `bureau-tools.test.ts` unchanged (reversible; note as dead-code candidate in tasks/todo.md).
- Tests: update `__tests__/agents.test.ts` expected tool lists (~lines 18-21); optionally assert absence.
- Verify `app.tool_calls.count` drops to 0 in the probe trace (not just that getBureauProfile disappears — model may reach for getBureauDetail instead). Include one probe turn asking a detail outside the mask.
- May mask the duplicated-credix-reply bug (separate todo) — re-test but don't close it on suspicion.

## Phase D — outbound HTTPS keep-alive (last; smallest win; drop if inert)

Files: `package.json`, new `lib/http-dispatcher.ts`, `server.ts`

- Add `"undici": "^6.23.0"` (Node 20.20.2 bundles 6.24.1, Node 22.22.x bundles 6.23.0 — same major; npm setGlobalDispatcher reaches built-in fetch via the shared `Symbol.for('undici.globalDispatcher.1')` registry, verified empirically). Comment: npm major must track runtime bundled major; revisit on Node 24 (undici 7).
- `lib/http-dispatcher.ts` (side-effect leaf): `if (!process.versions.bun) setGlobalDispatcher(new Agent({ keepAliveTimeout: 60_000, keepAliveMaxTimeout: 600_000 }))` — Bun's fetch ignores it; guard keeps bun test clean.
- Import it FIRST in `server.ts` (NOT tracing.ts — that's skipped by `dev:untraced`/Studio). OTel undici instrumentation uses diagnostics_channel, unaffected by order.
- Caveat: a server `Keep-Alive: timeout=` hint below 60s wins over keepAliveTimeout. Verify in probe trace (turn-2+ POSTs without tls.connect children); if no change, revert the phase.

## Verification (per phase; lessons.md: real trace, never stdout)

1. Baseline: `bun run probe` multi-turn BEFORE Phase A; keep the trace id.
2. Per phase: `bunx tsc --noEmit` → `bun test` (188-pass baseline) → `bun run probe` → Honeycomb MCP `get_trace`:
   - A: `understand.classify` < 2s; reply quality eyeballed vs baseline (+ `score-improvement.qa.ts`).
   - B: `web.grounding` span overlaps classify; `app.web_grounding.used` present; exa POST no longer under `agent.generate`.
   - C: one x.ai POST per turn; `app.tool_calls.count` = 0 on typical turns.
   - D: no `tls.connect` under turn-2+ spans.
3. One concern per commit (git-practices); update `tasks/` (progress/todo/lessons) same turn as each commit.

## Out of scope

- Duplicated credix-agent reply bug (separate todo; re-test after C).
- Session-level intent reuse heuristic — only if intent-only classify still >2s after fallbacks.
- Streaming the specialist response (bigger UX rework).
