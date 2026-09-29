# Issue 004.1 — Building Blocks + Understanding Redesign — Implementation & Retrospective

**Tracking:** [ZT-496](https://finbud.atlassian.net/browse/ZT-496) · Epic [ZT-260](https://finbud.atlassian.net/browse/ZT-260) · GitHub [financebuddha/credix#8](https://github.com/financebuddha/credix/issues/8)
**Date:** 2026-06-26 · **Status:** complete (not yet committed) · **Spec:** [issues/004.1-building-blocks-understanding.md](../issues/004.1-building-blocks-understanding.md)

> Scope by design: 004.1 builds the **standalone components** the workflow composes. There is **no
> workflow assembly and no `index.ts` agent registration** here — those are 004.2. This kept the PR
> small and avoided the `index → agents → memory → index` import cycle before it was needed.

---

## 1. What we built

| # | Deliverable | File(s) | Summary |
|---|---|---|---|
| D1 | Rahul persona | `src/mastra/agents/persona.ts` | `RAHUL_PERSONA` static string: ≤120 words, digits-only numerics, never emit PAN/Aadhaar/full mobile, never fabricate, explain jargon, trust tool results. |
| D2 | 4 specialist agents | `src/mastra/agents/{score-improvement,credit-card,insurance,credix}.ts` | Real `new Agent()` on `grokModel` + `credixMemory` + tools. |
| D3 | Barrel | `src/mastra/agents/index.ts` | Re-exports the 4 agents. |
| D4 | Eligibility tool | `src/mastra/tools/eligibility.ts` | `checkCardEligibility` — pure decision tree, no I/O. |
| D5 | Memory singleton | `src/mastra/memory/index.ts` | `credixMemory` — one `Memory` over the shared `libsqlStore`. |
| D6 | Understand redesign | `src/mastra/steps/understand.ts`, `src/mastra/lib/provider.ts` | Thinking model + Mastra structured output emitting `{ intent, brief }`. |
| — | Tests | `src/mastra/__tests__/{eligibility,understand,agents}.test.ts` | New + rewritten. |

### Agent → tools wiring
- **score-improvement** → `getBureauProfile`, `getBureauDetail`
- **credit-card** → `getBureauProfile`, `getBureauDetail`, `checkCardEligibility`
- **insurance** → none (Phase-3 stub; no product/premium promises)
- **credix** → `getBureauProfile` (general fallback)

Wiring `grokModel` into all four **closed Sudhanshu review #4** — the provider exports were previously dead code.

### `checkCardEligibility` decision tree
```
cibil_score >= 750 AND monthly_income >= 25000  → premium
cibil_score >= 650                              → standard
otherwise                                       → secured
```
Pure function. `reason` states thresholds in digits (persona digits-only rule). Bureau data reaches the agent via `getBureauProfile`; this tool only scores the two extracted numbers.

### `credixMemory` (schema, not template)
`Memory({ storage: libsqlStore, options: { lastMessages: 20, workingMemory: { enabled: true, scope: 'resource', schema } } })` with a Zod schema of `goals[]`, `hard_constraints[]`, `prose_summary`. **Schema mode → merge semantics** (a partial write preserves other fields); a markdown `template` would use replace semantics and clobber unwritten fields. `scope: 'resource'` persists per user across sessions; libSQL is a resource-scope-capable adapter.

### `understandStep` redesign
Replaced the raw `fetch` + `json_object` call with a dedicated, stateless **understand agent** (grok-4.3, no memory, no tools) + Mastra **structured output**:
- LLM schema: `{ intent: enum(INTENT_VALUES), brief: { summary, points[2..5] } }` → `res.object`.
- Reasoning effort passed on the **top-level** `providerOptions.openai.reasoningEffort` (default `low`), model + effort env-tunable via `UNDERSTAND_MODEL` / `UNDERSTAND_REASONING`.
- Contract preserved exactly: `pre_guardrail:false` short-circuit (no LLM spend); missing `GROK_API_KEY` fails fast; non-2xx → `llm_<status>`, network throw → `llm_unreachable`, both degrade to `intent:'general'` + a fallback brief.

---

## 2. How we approached it (no-shortcuts planning)

1. **Read the session state first** (`lessons.md`, `todo.md`, `progress.md`) per the session-start ritual.
2. **Explored the codebase** with parallel agents — mapped `provider.ts`, the step/agent/memory stubs, `patterns.ts`, and the `bun:test` conventions.
3. **Verified the risky APIs twice** before writing code: against the **installed** `node_modules` `.d.ts` (`@mastra/core` 1.45.0, `@mastra/memory` 1.21.0, `@ai-sdk/openai` 3.0.74) **and** the Mastra docs MCP. This is the step that caught the spec being wrong (see §3).
4. **Used the requested skills** (`mastra`=best-practices, `mastra-smoke-test`, `debugging-difficult-bugs`) and the docs MCP to ground idioms instead of trusting model memory.
5. Built in dependency order: persona → memory → eligibility → agents → barrel → understand → tests.

---

## 3. Issues we faced

### 3.1 The Issue-004 spec disagreed with the installed API (caught in planning)
Three spec snippets would not have compiled / would have silently misbehaved. Found by reading the actual `.d.ts`, **not** by trusting the spec:

| Spec said | Installed reality |
|---|---|
| `updateWorkingMemory({ resourceId, threadId, data: {...} })` | `updateWorkingMemory({ threadId, resourceId, workingMemory: <string> })` |
| `result.steps[].toolCalls[].toolName / .args`, `toolResults[].result` | wrapped in `.payload`: `tc.payload.toolName`, `tc.payload.args`, `tr.payload.result`, `tr.payload.toolCallId` |
| `agent.generate(..., { memory: { resource, thread } })` | correct — confirmed, no change |

The first two bite **004.2** (memory writeback + `tool_calls_log`), so they are recorded as forward-flags in `lessons.md` rather than fixed here.

### 3.2 First test run: 12 failures — `mock.module` couldn't reach the agent
The understand tests all fell into the degradation path (`llm_unreachable`), and the 503 test got `llm_unreachable` instead of `llm_503` — i.e. the **real** `Agent.generate()` was running and making a live network call, not the mock.

**Root cause:** Bun hoists `import` statements above top-level `mock.module()` calls. The original `understand.ts` built `understandAgent` at **module load** (a top-level `new Agent()`), which executed during the hoisted import — *before* the test's `mock.module('@mastra/core/agent', …)` registered. So the agent captured the real `Agent` class.

**Why `steps.test.ts` (ElevenLabs) didn't have this problem:** `decode.ts`/`compose.ts` construct their `ElevenLabsClient` **lazily inside `execute`**, so by the time the step runs the mock is already in place.

**Fix:** Memoise the understand agent behind `getUnderstandAgent()` and build it on first `execute`, not at import. This also helps production (no agent constructed during `mastra build` static analysis).

### 3.3 The module-level specialist agents are unmockable the same way
The 4 specialist agents are deliberately module-level singletons (004.2 registers them with Mastra), so the same hoisting problem means `mock.module` can't control how they're built either. Rather than fight it, `agents.test.ts` uses the **real** `Agent` (construction is offline + synchronous, so it still proves wiring) and leans on bun's **alphabetical file order** — `agents.test.ts` runs before `understand.test.ts`, so the agents barrel is imported before any file mocks `@mastra/core/agent`.

### 3.4 Skill names didn't match the request
- `mastra-hono` — not published in `jwynia/agent-skills` (only `document-to-narration` there). It was reference-only for 004.1 anyway (Hono wiring is 004.3), so no impact.
- `mastra-best-practices` — published as `mastra` in `mastra-ai/skills`; installed that instead.

---

## 4. What we learnt

1. **Construct Mastra `Agent`s / external clients lazily, never at module top-level** — otherwise tests can't mock them (bun import hoisting) and `mastra build` may construct them during analysis.
2. **Verify SDK APIs against installed `.d.ts` + docs MCP, not the spec or model memory.** The spec was authored against a different (or assumed) API shape; the `.d.ts` is the source of truth for the exact installed version.
3. **Mastra structured output ergonomics:** `agent.generate(msg, { structuredOutput: { schema, errorStrategy:'fallback', fallbackValue } })` returns the typed object on `res.object`. Schema-validation failures degrade via `fallback`; transport/HTTP errors still **throw**, so the try/catch is still required. Reasoning effort for a single thinking model goes on the **top-level** `providerOptions`, not inside `structuredOutput` (that path feeds a *separate* structuring model, which we don't use).
4. **Working memory: schema vs template is a semantics decision, not a style one** — schema = merge (safe partial updates), template = replace (clobbers). We need merge, so schema.
5. **Bun test ordering is alphabetical and `mock.module` is process-global** — both can be leveraged (run order) and can bite (cross-file bleed). The repo already mitigates bleed via `afterAll` cleanup and env-gated integration tests.

---

## 5. What we failed at / rough edges

- **First implementation didn't run green.** The module-load agent construction (§3.2) meant a 12-failure first run. Caught and fixed within the session, but it was avoidable had we applied the "lazy construction" lesson up front (it was already visible in `decode.ts`/`compose.ts`).
- **Test isolation relies on file ordering, not true isolation.** `agents.test.ts` working depends on it being alphabetically before `understand.test.ts`. It's deterministic in bun today, but it's an implicit coupling, not an enforced one (see Improvements).
- **No live LLM verification.** The understand step's structured-output call against real grok-4.3 is unverified — all tests mock the agent. We don't yet know empirically that xAI honours the `response_format` JSON-schema path for grok-4.3 (only that the AI-SDK/Mastra types accept it). First real confirmation comes in 004.3 E2E or a manual probe.
- **`mastra-smoke-test` skill not actually run.** It targets a live Studio/dev server + bureau sidecar, which doesn't exist for an unassembled workflow. We substituted a standalone import smoke; the real smoke test waits for 004.3.

---

## 6. Improvements (follow-ups)

| Priority | Improvement | Where |
|---|---|---|
| High | Apply the three forward-flags when building 004.2 (updateWorkingMemory string signature, `.payload` tool-trace shape, import-cycle ordering). | 004.2 |
| High | One live probe of the understand step against real grok-4.3 to confirm structured-output works (and that `reasoningEffort` is accepted), before relying on it in E2E. | 004.2/004.3 |
| Medium | Make agent-test isolation explicit instead of order-dependent — e.g. a shared test helper that registers the `@mastra/core/agent` mock + restores it in `afterAll`, or a dependency-injection seam so agents can be built with a stub model in tests. | tests |
| Medium | Add a tiny unit asserting the understand **output schema** validates the degradation payload (brief with <2 points), to lock the "LLM schema strict, step schema relaxed" split. | understand.test |
| Low | Consider hoisting the `new ElevenLabsClient()` out of the `withRetry` closure (Sudhanshu review #6) while we're applying the lazy-construction lesson broadly. | 004.3 |
| Low | Document the env knobs (`UNDERSTAND_MODEL`, `UNDERSTAND_REASONING`, `LLM_MODEL`) in `.env.example` with the grok-4.3 reasoning note. | 004.3 |

---

## 7. Verification snapshot

```
bunx tsc --noEmit -p src/mastra/tsconfig.json   → exit 0
bun test src/mastra/__tests__                   → 149 pass · 9 skip · 0 fail   (was 121)
standalone import smoke                          → no circular-import crash; all 4 agents share one credixMemory
```

Acceptance criteria (spec): all met — tests green, `tsc` 0, `grokModel` imported by all 4 agents, `credixMemory` singleton over the shared `libsqlStore`, `understandStep` emits `brief.points` and preserves short-circuit / fail-fast / graceful degradation.

**Not committed yet** — awaiting go-ahead per `git-practices.md`.
