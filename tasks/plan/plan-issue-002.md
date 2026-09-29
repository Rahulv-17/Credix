# Plan: Issue 002 — Deterministic Steps, Tools & Tests

## Context

Issue 001 bootstrapped the Hono + Mastra layer (PR #4, ZT-435). The next phase is
implementing every step and tool that needs **zero LLM calls and zero network I/O** —
pure deterministic TypeScript. These must be green before LLM/network code lands in
Issue 003 so there is a stable, fast-running test baseline.

All 6 source files currently exist as comment-only stubs. `patterns.ts` is already
complete (all regex constants, `STEP_IDS`, `INTENT_VALUES`). The `__tests__/`
directory does not exist yet.

---

## Files to create / overwrite

| Path | Action | Issue-spec section |
|---|---|---|
| `src/mastra/steps/decode.ts` | overwrite stub | §1 |
| `src/mastra/steps/pre-guardrail.ts` | overwrite stub | §2 |
| `src/mastra/steps/post-guardrail.ts` | overwrite stub | §3 |
| `src/mastra/steps/compose.ts` | overwrite stub | §4 |
| `src/mastra/tools/eligibility.ts` | overwrite stub | §5 |
| `src/mastra/tools/calculators.ts` | overwrite stub | §6 |
| `src/mastra/__tests__/steps.test.ts` | create (dir missing) | §Vitest tests |
| `src/mastra/__tests__/tools.test.ts` | create (dir missing) | §Vitest tests |
| `tasks/todo.md` | update Issue 002 → complete | acceptance criteria |
| `tasks/findings.md` | add regex lastIndex note | acceptance criteria |

**Do NOT touch:** `understand.ts`, `identity-check.ts`, `memory-writeback.ts`,
`user-story.ts`, `bureau.ts`, `credix-workflow.ts`, `lib/patterns.ts`, `index.ts`.

---

## Implementation detail per file

### `steps/decode.ts`
- `LANG_RANGES` lookup table: `[lo, hi, lang]` for Devanagari(hi), Gujarati(gu), Bengali(bn), Tamil(ta)
- `detectLanguage(text)`: count codepoints in each range, return dominant; fallback `'en'`
- `decodeStep`: `inputSchema { message }` → NFC-normalize → `{ language, decoded_text }`
- Uses `STEP_IDS.DECODE` from `../lib/patterns`

### `steps/pre-guardrail.ts`
- Imports `INJECTION_PATTERNS`, `SCOPE_PATTERNS`, `STEP_IDS` from `../lib/patterns`
- `inputSchema { decoded_text }` → test injection then scope → `{ guardrail_ok, guardrail_reason?, decoded_text }`
- **Pass-through `decoded_text`** in output — `understandStep` (Issue 003) reads it from here

### `steps/post-guardrail.ts`
- Imports `PAN_PATTERN`, `AADHAAR_PATTERN`, `MOBILE_PATTERN`, `STEP_IDS` from `../lib/patterns`
- **Reconstructs each regex** with `new RegExp(pattern.source, 'g')` on every call — never reuse the exported `/g` object directly (global regex retains `lastIndex` state across calls, causing silent misses on second invocation)
- Scrub order: Aadhaar first, then PAN, then mobile — avoids partial Aadhaar match as two mobiles
- CIBIL scores (3-digit 300–900) intentionally NOT redacted — `MOBILE_PATTERN` has `\b` word boundaries that prevent matching partial strings

### `steps/compose.ts`
- `Channel = z.enum(['whatsapp', 'web', 'tts'])`
- `toWhatsApp`: strip `**bold**`, `_italic_`, headings, convert `- ` bullets → `– `, truncate paragraphs to 3 lines
- `toTts`: strip all markdown symbols, parentheticals, collapse newlines to space
- `web`: pass through unchanged
- Default `active_skill` = `'general'` when not provided

### `tools/eligibility.ts`
- `checkCardEligibility`: score ≥ 750 **AND** income ≥ 25000 → premium; score ≥ 650 → standard; else secured
- Boundary: `{ score: 749, income: 25001 }` → standard (score fails first check)
- `createTool` execute receives `inputData` as **direct first arg** (not destructured `{ inputData }` — that is `createStep` API only)

### `tools/calculators.ts`
- `calculateEmi`: `r = annual_rate/12/100`, `emi = P*r*(1+r)^n / ((1+r)^n − 1)`, return `"EMI: ${Math.round(emi)}"`
- `calculateFoir`: guard `if (monthly_income <= 0)` → error string (never throw); else `"FOIR: ${(o/i*100).toFixed(1)}%"`
- No `.min()` on `monthly_income` in schema — negative values must reach execute for the guard to work

### `__tests__/steps.test.ts` + `tools.test.ts`
- Step test helper: `const exec = (step: any, inputData: any) => step.execute({ inputData, mastra: null, getInitData: () => ({}), getStepResult: () => undefined })` — `any` types bypass strict checking on `Step.execute`
- **Tool test helper required (deviation from spec):** `const execTool = (tool: any, inputData: any) => tool.execute(inputData)` — `any` types bypass three tsc errors that the verbatim spec code would produce:
  1. `Tool.execute` is typed `execute?: ...` (optional) — calling without `!` fails
  2. `Tool.execute` signature is `(inputData, context)` — calling with one arg fails
  3. Return type is `TSchemaOut | ValidationError | void` — property access (`.tier`, `.result`) fails on the union
- Replace all `checkCardEligibility.execute({...})`, `calculateEmi.execute({...})`, `calculateFoir.execute({...})` calls in `tools.test.ts` with `execTool(tool, inputData)`
- All other test cases from the issue spec verbatim

---

## Key reused artifacts

- `src/mastra/lib/patterns.ts` — already complete; provides all regex and constants. **Read-only.**
- `src/mastra/tsconfig.json` — `"moduleResolution": "bundler"`, `"strict": true`. Imports from `@mastra/core/workflows` and `@mastra/core/tools` are correct (verified against Mastra 1.45.0).
- `src/mastra/package.json` — `"test": "vitest run"`, `"typecheck": "tsc --noEmit"`. Both binaries installed.

---

## Execution order

1. Overwrite the 4 step stubs (decode → pre-guardrail → post-guardrail → compose)
2. Overwrite the 2 tool stubs (eligibility → calculators)
3. Create `src/mastra/__tests__/` directory and write both test files
4. Run `bun run typecheck` from `src/mastra/` — fix any type errors before proceeding
5. Run `bun test` from `src/mastra/` — all cases must be green
6. Update `tasks/todo.md` (Issue 002 → complete, ensure Issue 003 listed as next)
7. Add global regex `lastIndex` finding to `tasks/findings.md`
8. Run `verify` skill, then commit with scope `agents`

---

## Verification

```bash
cd src/mastra
bun run typecheck       # exit 0  (runs `tsc --noEmit` via package.json script)
bun test                # all tests green (steps: ~18 cases, tools: ~12 cases)
```

> `bun test` uses bun's native test runner which is API-compatible with vitest's `describe`/`it`/`expect`. No test file changes needed.

Manual spot-checks:
- `postGuardrailStep` on `"CIBIL score is 750"` → `750` preserved
- `checkCardEligibility({ cibil_score: 749, monthly_income: 25001 })` → `standard`
- `calculateFoir({ monthly_obligations: 5000, monthly_income: 0 })` → error string, no throw

---

## Grill findings (self-review — 12 rounds)

| Round | Finding | Status |
|---|---|---|
| 1 | Baseline typecheck is clean — all out-of-scope stubs are comment-only | no action |
| 2 | **`Tool.execute` is optional (`execute?:`) and requires 2 args — tools test needs `execTool` helper** | patched above |
| 3 | No test validates `lastIndex` fix by calling step twice — gap noted, not blocking | note in findings.md |
| 4 | `preGuardrailStep` schema table is stale (missing `decoded_text`) — §2 code is authoritative | already noted |
| 5 | Import paths `@mastra/core/workflows` and `@mastra/core/tools` are correct (verified 1.45.0) | no action |
| 6 | Mastra 1.45.0 `createStep`/`createTool` API matches spec exactly | no action |
| 7 | Zod 4.4.3 — all spec APIs compatible (`.min()`, `.default()`, `.enum()`, `.optional()`) | no action |
| 8 | `calculateFoir` guard: `monthly_income: z.number()` (no min) lets `-100` reach execute | no action |
| 9 | `composeStep` needs `session_id` via `getInitData()` in the workflow — not a bug for Issue 002 | flag for Issue 004 findings |
| 10 | `toWhatsApp` truncation: 6 single-`\n` lines → 1 paragraph → 3 lines. Test passes | no action |
| 11 | Gujarati codepoints all in `[0x0A80, 0x0AFF]` — detection test correct | no action |
| 12 | `AADHAAR_PATTERN` matches 12 digits with no spaces — `\s?` allows zero spaces | no action |

---

## Out of scope (Issue 003+)

- `understand.ts` (LLM call), `identity-check.ts` (bureau HTTP), `memory-writeback.ts`, `bureau.ts`
- `credix-workflow.ts` wiring
- Agent registrations in `index.ts`
