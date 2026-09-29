# Issue 003 — Bureau Tools, Identity Check, and LLM Steps

**Type:** AFK
**Blocked by:** `issues/002-deterministic-steps-tools.md` — needs `patterns.ts` (STEP_IDS, INTENT_VALUES), `@mastra/core` installed, step contracts established
**PRD sections:** Implementation Decisions §4 (LLM provider), §6 (routing), §7 (tool_calls_log), User Stories 2, 3, 9, 15–18

---

## What to build

Implement the steps and tools that require either a live HTTP call (bureau sidecar) or an LLM call (understand). The specialist agents are NOT in this issue — they land in Issue 004.

Notable design decision from grilling: **`identityCheckStep` exists as a tested unit but is NOT wired into the workflow**. Identity verification runs in Hono's `POST /v1/chat` handler before the workflow starts. This keeps the Mastra workflow pure — it always starts with a verified user and a pre-fetched bureau profile. The step is implemented here for testability and as a reusable utility, not for workflow inclusion.

`understandStep` incorporates the guardrail gate. It reads `pre-guardrail` step output via `getStepResult()` and short-circuits (returns `guardrail_ok: false`) without an LLM call when the guardrail rejected. This avoids paying LLM tokens on injection/out-of-scope queries.

---

## Exact deliverables

### 1. `src/mastra/tools/bureau.ts`

```typescript
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'

// Read at call time — never cache at module load
const getSidecarUrl = () => process.env.BUREAU_SIDECAR_URL ?? 'http://localhost:8000'
const getToken = () => process.env.INTERNAL_API_SECRET ?? ''

const sidecarHeaders = () => ({
  'Content-Type': 'application/json',
  'X-Internal-Token': getToken(),
})

const VALID_SECTIONS = [
  'general_info', 'loan_details', 'enquiries', 'loan_repayments',
  'loan_patterns', 'borrowing_window', 'institution_details', 'dpd',
] as const
type BureauSection = typeof VALID_SECTIONS[number]

export const getBureauProfile = createTool({
  id: 'getBureauProfile',
  description: 'Fetch the full PII-stripped bureau profile for a user. user_id is their bare 10-digit mobile.',
  inputSchema: z.object({
    user_id: z.string().length(10).regex(/^\d{10}$/, 'Must be exactly 10 digits'),
  }),
  outputSchema: z.object({
    general_info: z.record(z.unknown()),
    loan_details: z.record(z.unknown()).optional(),
    enquiries: z.record(z.unknown()).optional(),
    loan_repayments: z.record(z.unknown()).optional(),
    loan_patterns: z.record(z.unknown()).optional(),
    borrowing_window: z.record(z.unknown()).optional(),
    institution_details: z.record(z.unknown()).optional(),
    dpd: z.record(z.unknown()).optional(),
    _meta: z.record(z.unknown()).optional(),
  }),
  execute: async (inputData) => {
    const res = await fetch(`${getSidecarUrl()}/internal/bureau/${inputData.user_id}`, {
      headers: sidecarHeaders(),
    })
    if (res.status === 404) throw new Error('No bureau record found for this user')
    if (!res.ok) throw new Error(`Bureau sidecar returned ${res.status}`)
    const profile = await res.json()
    // PII invariant: pii key must never reach agents — strip defensively
    delete profile.pii
    return profile
  },
})

export const getBureauDetail = createTool({
  id: 'getBureauDetail',
  description: 'Fetch a single section of the bureau profile. Prefer this for targeted lookups to avoid fetching the full profile.',
  inputSchema: z.object({
    user_id: z.string().length(10),
    section: z.enum(VALID_SECTIONS),
  }),
  outputSchema: z.record(z.unknown()),
  execute: async (inputData) => {
    const res = await fetch(
      `${getSidecarUrl()}/internal/bureau/${inputData.user_id}/${inputData.section}`,
      { headers: sidecarHeaders() },
    )
    if (res.status === 404) throw new Error(`Section '${inputData.section}' not found`)
    if (!res.ok) throw new Error(`Bureau sidecar returned ${res.status} for section '${inputData.section}'`)
    return res.json()
  },
})
```

> `INTERNAL_API_SECRET` is read at call time via `getToken()`, not at module load. This is critical — the env var may not be set when the module first imports (e.g. during test setup), and caching an empty string would cause silent 403 failures on all sidecar calls.
>
> The `delete profile.pii` in `getBureauProfile` is defence-in-depth. The Python `RedisRepo` strips `pii` at write time — if `pii` appears in the response, it signals a bug in the Python layer. Stripping it here prevents PII from reaching agent context regardless.
>
> `getBureauDetail` section validation is a Zod enum — invalid sections never reach the sidecar. The sidecar returns 400 for invalid sections as an additional layer.

### 2. `src/mastra/steps/identity-check.ts`

This step exists as a tested unit and is used by Hono's `server.ts` directly via `normalizeUserId()`. **It is NOT wired into the Mastra workflow** — identity verification happens at the Hono API boundary before `credixWorkflow` runs.

```typescript
import { createStep } from '@mastra/core/workflows'
import { z } from 'zod'

// Exported for direct use in server.ts
export function normalizeUserId(mobile: string): string {
  const digits = mobile.replace(/\D/g, '')
  // Strip +91 or 91 country code if present
  return digits.startsWith('91') && digits.length === 12 ? digits.slice(2) : digits.slice(-10)
}

const SIDECAR_URL = () => process.env.BUREAU_SIDECAR_URL ?? 'http://localhost:8000'
const TOKEN = () => process.env.INTERNAL_API_SECRET ?? ''

// The step is provided for testing and future use. Not included in credix-workflow.
export const identityCheckStep = createStep({
  id: 'identity-check',
  description: 'Normalize mobile to user_id and resolve bureau profile from sidecar',
  inputSchema: z.object({
    mobile: z.string(),
    session_id: z.string(),
    message: z.string(),
    channel: z.string().default('web'),
  }),
  outputSchema: z.object({
    user_id: z.string(),
    session_id: z.string(),
    message: z.string(),
    channel: z.string(),
    bureau_profile: z.record(z.unknown()).optional(),
    identity_verified: z.boolean(),
    error: z.string().optional(),
  }),
  execute: async ({ inputData }) => {
    const user_id = normalizeUserId(inputData.mobile)
    const base = {
      user_id,
      session_id: inputData.session_id,
      message: inputData.message,
      channel: inputData.channel,
    }
    try {
      const res = await fetch(`${SIDECAR_URL()}/internal/bureau/${user_id}`, {
        headers: { 'X-Internal-Token': TOKEN() },
      })
      if (res.status === 404) {
        return { ...base, identity_verified: false, error: 'no bureau record found' }
      }
      if (!res.ok) {
        return { ...base, identity_verified: false, error: `sidecar error ${res.status}` }
      }
      const bureau_profile = await res.json()
      delete bureau_profile.pii
      return { ...base, bureau_profile, identity_verified: true }
    } catch (e) {
      return { ...base, identity_verified: false, error: String(e) }
    }
  },
})
```

### 3. `src/mastra/steps/understand.ts`

The critical design: `understandStep` is the step AFTER `preGuardrailStep` in the workflow chain. It reads the guardrail result via `getStepResult()` and short-circuits without an LLM call if the guardrail rejected. It passes `guardrail_ok` through in its output so the workflow `branch()` can gate on it.

```typescript
import { createStep } from '@mastra/core/workflows'
import { z } from 'zod'
import { Agent } from '@mastra/core/agent'
import { grokModel } from '../lib/provider'
import { STEP_IDS, INTENT_VALUES, type Intent } from '../lib/patterns'

const understandOutputSchema = z.object({
  intent: z.enum(INTENT_VALUES),
  entities: z.record(z.string()).default({}),
  guardrail_ok: z.boolean(),
  guardrail_reason: z.string().optional(),
})

// Internal agent — only used inside this step
const understandAgent = new Agent({
  id: 'understand-agent',
  name: 'Understand',
  instructions: `You are a classifier. Extract the user's intent and key entities from their message.
Intent must be exactly one of: ${INTENT_VALUES.join(', ')}.
- bureau_query: user wants their CIBIL score, report, or account data
- score_improvement: user wants to improve or understand their credit score
- credit_card: user asking about credit card eligibility or recommendations
- insurance: user asking about credit-linked insurance
- general: any other credit-related question

Entities are key facts mentioned: loan_amount, emi_amount, target_score, income, card_name, timeline.
Return ONLY valid JSON with keys "intent" and "entities". No markdown fences. No explanation.`,
  model: grokModel,
})

export const understandStep = createStep({
  id: STEP_IDS.UNDERSTAND,
  description: 'Gate on guardrail result, then LLM-classify intent and extract entities',
  inputSchema: z.object({
    decoded_text: z.string(),
    guardrail_ok: z.boolean(),
    guardrail_reason: z.string().optional(),
  }),
  outputSchema: understandOutputSchema,
  execute: async ({ inputData, getInitData }) => {
    // Short-circuit: don't call LLM if guardrail rejected
    if (!inputData.guardrail_ok) {
      return {
        intent: 'general' as Intent,  // dummy — branch will route to guardrail-reject step
        entities: {},
        guardrail_ok: false,
        guardrail_reason: inputData.guardrail_reason,
      }
    }

    const { bureau_profile } = getInitData() as { bureau_profile?: Record<string, unknown> }
    const cibilScore = (bureau_profile as any)?.general_info?.SCORE ?? 'unknown'

    const prompt = `User message: "${inputData.decoded_text}"
CIBIL score context: ${cibilScore}

Return JSON: { "intent": "<one of ${INTENT_VALUES.join('|')}>", "entities": { ...key facts... } }`

    const result = await understandAgent.generate(prompt, {
      structuredOutput: {
        schema: z.object({
          intent: z.enum(INTENT_VALUES),
          entities: z.record(z.string()).default({}),
        }),
      },
    })

    return {
      intent: result.object.intent,
      entities: result.object.entities,
      guardrail_ok: true,
    }
  },
})
```

> **Why `understandStep` reads `guardrail_ok` from `inputData`**: `preGuardrailStep` passes `guardrail_ok` and `decoded_text` in its output. Since `understandStep` comes immediately after in the `.then()` chain, its `inputData` IS the output of `preGuardrailStep`. No `getStepResult()` needed — the data arrives directly.
>
> **structuredOutput with Grok:** xAI Grok supports `response_format` natively so `structuredOutput` with a Zod schema works without `jsonPromptInjection`. The result is in `result.object`, not `result.text`. If Grok returns malformed JSON, Mastra retries automatically up to the model's default retry limit.
>
> **Temperature:** `understandAgent` should be deterministic. Add `{ temperature: 0 }` to the model config if the Mastra/xAI provider supports it — consistent intent classification is more important than creative variation here.

### 4. `src/mastra/steps/memory-writeback.ts`

Skeleton for Issue 003. Full implementation in Issue 004 when the memory singleton exists.

```typescript
import { createStep } from '@mastra/core/workflows'
import { z } from 'zod'
import { STEP_IDS } from '../lib/patterns'

export const memoryWritebackStep = createStep({
  id: STEP_IDS.MEMORY_WRITEBACK,
  description: 'Persist goals, constraints, and tool_calls_log to working memory (implemented in Issue 004)',
  inputSchema: z.object({
    user_id: z.string(),
    session_id: z.string(),
    intent: z.string(),
    entities: z.record(z.string()),
    tool_calls_log: z.array(z.object({
      tool: z.string(),
      input: z.record(z.unknown()),
      output: z.unknown().nullable(),
    })).default([]),
  }),
  outputSchema: z.object({}),
  execute: async () => {
    // Skeleton — wired to actual memory in Issue 004
    return {}
  },
})
```

---

## Mocked tests

### `src/mastra/__tests__/bureau-tools.test.ts`

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { getBureauProfile, getBureauDetail } from '../tools/bureau'

beforeEach(() => { vi.stubGlobal('fetch', vi.fn()) })
afterEach(() => { vi.unstubAllGlobals() })

describe('getBureauProfile', () => {
  it('returns profile without pii key on 200', async () => {
    const fixture = { general_info: { SCORE: 730 }, loan_details: {}, _meta: {} }
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ ...fixture, pii: { pan: 'ABCDE1234F' } }),  // pii in response
    } as Response)

    const result = await getBureauProfile.execute({ user_id: '9876543210' })
    expect(result.general_info).toBeDefined()
    expect((result as any).pii).toBeUndefined()  // must be stripped
  })

  it('throws on 404 with descriptive message', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 404 } as Response)
    await expect(getBureauProfile.execute({ user_id: '9876543210' }))
      .rejects.toThrow('No bureau record found')
  })

  it('throws on 500', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 500 } as Response)
    await expect(getBureauProfile.execute({ user_id: '9876543210' }))
      .rejects.toThrow('500')
  })

  it('sends X-Internal-Token header', async () => {
    process.env.INTERNAL_API_SECRET = 'test-secret'
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true, status: 200, json: async () => ({ general_info: {} }),
    } as Response)

    await getBureauProfile.execute({ user_id: '9876543210' })

    const callArgs = vi.mocked(fetch).mock.calls[0]
    const headers = (callArgs[1] as RequestInit)?.headers as Record<string, string>
    expect(headers['X-Internal-Token']).toBe('test-secret')
    delete process.env.INTERNAL_API_SECRET
  })
})

describe('getBureauDetail', () => {
  it('returns the requested section', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ loan_details: { active: 3 } }),
    } as Response)
    const result = await getBureauDetail.execute({ user_id: '9876543210', section: 'loan_details' })
    expect(result).toHaveProperty('loan_details')
  })

  it('throws on 404', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 404 } as Response)
    await expect(getBureauDetail.execute({ user_id: '9876543210', section: 'dpd' }))
      .rejects.toThrow("'dpd'")
  })
})
```

### `src/mastra/__tests__/identity-check.test.ts`

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { identityCheckStep, normalizeUserId } from '../steps/identity-check'

beforeEach(() => { vi.stubGlobal('fetch', vi.fn()) })
afterEach(() => { vi.unstubAllGlobals() })

const exec = (inputData: any) => identityCheckStep.execute({
  inputData,
  mastra: null,
  getInitData: () => ({}),
  getStepResult: () => undefined,
})

describe('normalizeUserId', () => {
  it('strips +91 prefix', () => {
    expect(normalizeUserId('+919876543210')).toBe('9876543210')
  })
  it('strips 91 prefix (12 digits)', () => {
    expect(normalizeUserId('919876543210')).toBe('9876543210')
  })
  it('passes through 10-digit mobile unchanged', () => {
    expect(normalizeUserId('9876543210')).toBe('9876543210')
  })
  it('strips spaces and dashes', () => {
    expect(normalizeUserId('98765 43210')).toBe('9876543210')
  })
})

describe('identityCheckStep', () => {
  it('returns identity_verified: false on 404', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 404 } as Response)
    const result = await exec({ mobile: '9876543210', session_id: 's1', message: 'test', channel: 'web' })
    expect(result.identity_verified).toBe(false)
    expect(result.error).toBe('no bureau record found')
  })

  it('returns identity_verified: false — never throws on 404', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 404 } as Response)
    await expect(exec({ mobile: '9876543210', session_id: 's1', message: 'test', channel: 'web' }))
      .resolves.toBeDefined()  // resolves, not rejects
  })

  it('returns identity_verified: false on sidecar error', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('ECONNREFUSED'))
    const result = await exec({ mobile: '9876543210', session_id: 's1', message: 'test', channel: 'web' })
    expect(result.identity_verified).toBe(false)
    expect(result.error).toContain('ECONNREFUSED')
  })

  it('normalizes +91 prefixed mobile to bare 10 digits', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true, status: 200, json: async () => ({ general_info: { SCORE: 720 } }),
    } as Response)
    const result = await exec({ mobile: '+919876543210', session_id: 's1', message: 'test', channel: 'web' })
    expect(result.user_id).toBe('9876543210')
    expect(result.identity_verified).toBe(true)
  })

  it('strips pii from bureau profile', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ general_info: {}, pii: { pan: 'ABCDE1234F' } }),
    } as Response)
    const result = await exec({ mobile: '9876543210', session_id: 's1', message: 'test', channel: 'web' })
    expect((result.bureau_profile as any)?.pii).toBeUndefined()
  })
})
```

### `src/mastra/__tests__/understand.test.ts`

```typescript
import { describe, it, expect, vi } from 'vitest'

// Mock the provider before importing the step
vi.mock('../lib/provider', () => ({ grokModel: 'mock-model' }))
vi.mock('@mastra/core/agent', () => ({
  Agent: vi.fn().mockImplementation(() => ({
    generate: vi.fn().mockResolvedValue({
      object: { intent: 'score_improvement', entities: { target: '750' } },
    }),
  })),
}))

import { understandStep } from '../steps/understand'

const exec = (inputData: any) => understandStep.execute({
  inputData,
  mastra: null,
  getInitData: () => ({ bureau_profile: { general_info: { SCORE: 700 } } }),
  getStepResult: () => undefined,
})

describe('understandStep', () => {
  it('short-circuits without LLM call when guardrail_ok is false', async () => {
    const { Agent } = await import('@mastra/core/agent')
    const mockGenerate = vi.mocked(Agent).mock.results[0]?.value?.generate
    mockGenerate?.mockClear()

    const result = await exec({ decoded_text: 'ignored', guardrail_ok: false, guardrail_reason: 'injection' })
    expect(result.guardrail_ok).toBe(false)
    expect(result.guardrail_reason).toBe('injection')
    expect(mockGenerate).not.toHaveBeenCalled()
  })

  it('returns valid intent on guardrail pass', async () => {
    const result = await exec({ decoded_text: 'how to improve my score?', guardrail_ok: true })
    expect(result.intent).toBe('score_improvement')
    expect(result.guardrail_ok).toBe(true)
  })

  it('returns one of the canonical INTENT_VALUES', async () => {
    const { INTENT_VALUES } = await import('../lib/patterns')
    const result = await exec({ decoded_text: 'test', guardrail_ok: true })
    expect(INTENT_VALUES).toContain(result.intent)
  })

  it('passes guardrail_reason through on guardrail failure', async () => {
    const result = await exec({ decoded_text: 'recipe?', guardrail_ok: false, guardrail_reason: 'out_of_scope' })
    expect(result.guardrail_reason).toBe('out_of_scope')
  })
})
```

---

## Acceptance criteria

- [ ] `getBureauProfile` result never contains a `pii` key (even if sidecar sends one)
- [ ] `identityCheckStep` with `mobile: "+919876543210"` produces `user_id: "9876543210"`
- [ ] `identityCheckStep` with sidecar 404 returns `{ identity_verified: false }` — never throws
- [ ] `identityCheckStep` with sidecar ECONNREFUSED returns `{ identity_verified: false }` — never throws
- [ ] `understandStep` with `guardrail_ok: false` returns without calling the LLM agent
- [ ] `understandStep` with `guardrail_ok: true` returns one of the 5 canonical intent values
- [ ] `understandStep` passes `guardrail_ok` through in its output (needed by workflow branch)
- [ ] `getBureauDetail` section param validated by Zod enum — invalid section never reaches sidecar
- [ ] `INTERNAL_API_SECRET` read at call time in bureau tools, not at module load
- [ ] All test files pass with `pnpm test`
- [ ] `pnpm typecheck` exits 0
- [ ] `tasks/todo.md`: Issue 003 complete, Issue 004 in_progress
- [ ] `tasks/findings.md`: note xAI Grok structured output (no `jsonPromptInjection` needed); note `getInitData()` for accessing workflow input from any step

## Key constraints to carry forward

- `identityCheckStep` is NOT imported or used in `credix-workflow.ts` — it exists for testing only
- `normalizeUserId()` is exported from `identity-check.ts` and imported in `server.ts`
- `understandStep.inputSchema` expects `{ decoded_text, guardrail_ok, guardrail_reason? }` — this exactly matches `preGuardrailStep.outputSchema` (including the pass-through `decoded_text`)
- `understandStep.outputSchema` includes `guardrail_ok` — the workflow branch in Issue 004 reads this from `inputData` to gate the guardrail-reject path
- `memoryWritebackStep` is a no-op skeleton — do NOT implement the memory write here; memory config doesn't exist until Issue 004
