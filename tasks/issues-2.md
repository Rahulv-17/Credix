# Issue 002 — Deterministic Steps, Tools & TTS/STT Hardening

**PR:** `dev → main`
**Branch:** `dev`
**Date:** 2026-06-25
**Author:** Suraj Harlekar
**Commits:** `8c8c7ae` → `0c26ab1`
**Test result:** 98 pass · 9 skip · 0 fail

---

## Overview

Issue 002 implements the full Mastra TypeScript pipeline layer for Credix AI — a credit intelligence assistant for Indian users. It delivers four deterministic workflow steps (`decode`, `pre-guardrail`, `post-guardrail`, `compose`), two financial calculator tools, a shared retry utility, and a 98-test suite covering unit, integration, and retry scenarios.

The TTS/STT hardening phase (second half of the issue) wraps both ElevenLabs calls with `withRetry`, fixes a Bun runtime incompatibility with the ElevenLabs SDK's file upload path, resolves a `.env` formatting bug that corrupted the API key, and adds 6 targeted retry tests.

---

## Deliverables

| File | Type | Description |
|------|------|-------------|
| `src/mastra/steps/decode.ts` | Step | NFC normalization, script-based language detection, ElevenLabs STT with retry |
| `src/mastra/steps/pre-guardrail.ts` | Step | Injection/scope filter, bureau sidecar fetch, partial PII masking |
| `src/mastra/steps/post-guardrail.ts` | Step | PII redaction — scrub order Aadhaar → PAN → mobile, lastIndex-safe |
| `src/mastra/steps/compose.ts` | Step | Channel formatter — WhatsApp, web passthrough, TTS (ElevenLabs) with retry |
| `src/mastra/lib/retry.ts` | Lib | `withRetry<T>(fn, label, maxAttempts=3)` — exponential backoff, fast-fail 4xx |
| `src/mastra/tools/calculators.ts` | Tool | `calculateEmi` + `calculateFoir` |
| `src/mastra/__tests__/steps.test.ts` | Test | Unit + retry tests — 98 pass, 9 skip |
| `src/mastra/__tests__/tools.test.ts` | Test | EMI and FOIR calculator correctness |
| `src/mastra/__tests__/integration.test.ts` | Test | Live ElevenLabs + Bureau tests (guarded by env flags) |
| `src/mastra/__tests__/patterns.test.ts` | Test | Pattern matching — injection and PII regex |
| `temp/tests/tts-probe.ts` | Probe | Live end-to-end TTS + STT probe with 5 named sections |
| `.env` | Config | Fixed key/voice on separate lines (were on one line) |

---

## Pipeline Architecture

```mermaid
flowchart TD
    A([Client]) -->|POST /chat\nmessage or audio_url| B[Hono Server\nsrc/mastra/server.ts]
    B --> C[Mastra Workflow\nsteps wired in order]

    C --> D[decodeStep]
    D -->|audio_url present| D1[ElevenLabs Scribe v2\nwithRetry 3x]
    D1 -->|languageCode eng/hin/...| D
    D -->|message input| D2[NFC normalize\nscript-range lang detect]
    D --> E{decoded_text\nlanguage}

    E --> F[preGuardrailStep]
    F -->|INJECTION_PATTERNS match| G([Reject — guardrail_reason: injection])
    F -->|SCOPE_PATTERNS match| H([Reject — guardrail_reason: out_of_scope])
    F -->|passed| I[Bureau Sidecar\nFastAPI /internal/bureau/user_id]
    I --> J[Partial PII Mask\nmobile 98XXXX3210\nPAN ABCXXXX34F\nAadhaar XXXXXXXX6666]
    J --> K{pre_guardrail: true\nmasked_profile}

    K --> L[LLM — understand step\nIssue 003]
    L --> M[postGuardrailStep\nfull PII redact]
    M --> N[composeStep]

    N -->|channel = tts| O[ElevenLabs Flash v2.5\nwithRetry 3x]
    O --> N
    N -->|whatsapp| P([WhatsApp\nmarkdown stripped\n3-line para cap])
    N -->|web| Q([Web\nmarkdown passthrough])
    N -->|tts| R([TTS\ndata:audio/mpeg;base64,...])
```

---

## Implementation Gantt

```mermaid
gantt
    title Issue 002 — Implementation Timeline
    dateFormat  YYYY-MM-DD

    section Steps
    decodeStep — NFC + lang detect         :done, s1, 2026-06-24, 1d
    preGuardrailStep — inject + scope      :done, s2, 2026-06-24, 1d
    postGuardrailStep — PII redact         :done, s3, 2026-06-24, 1d
    composeStep — WA + web + TTS stub      :done, s4, 2026-06-24, 1d

    section Tools
    calculateEmi + calculateFoir           :done, t1, 2026-06-24, 1d

    section Tests
    steps.test.ts — 92 unit tests          :done, ts1, 2026-06-24, 1d
    tools.test.ts — 9 calculator tests     :done, ts2, 2026-06-24, 1d
    integration.test.ts — guarded live     :done, ts3, 2026-06-24, 1d
    patterns.test.ts — regex patterns      :done, ts4, 2026-06-24, 1d

    section TTS/STT Hardening
    lib/retry.ts — withRetry utility       :done, r1, 2026-06-25, 1d
    compose.ts — TTS withRetry wrap        :done, r2, 2026-06-25, 1d
    decode.ts — STT withRetry + Bun fix    :done, r3, 2026-06-25, 1d
    mockState stateful + afterAll cleanup  :done, r4, 2026-06-25, 1d
    6 retry unit tests added               :done, r5, 2026-06-25, 1d
    .env formatting bug fixed              :done, r6, 2026-06-25, 1d
    temp/tests/tts-probe.ts live probe     :done, r7, 2026-06-25, 1d
```

---

## Sequence Diagram 1 — STT/TTS Retry Tests

Shows the three tested retry scenarios for both STT (decodeStep) and TTS (composeStep).

```mermaid
sequenceDiagram
    participant T as Test
    participant S as decodeStep / composeStep
    participant R as withRetry
    participant EL as ElevenLabs SDK (mock)

    Note over T,EL: Scenario A — 2 transient 503s, then success

    T->>S: execute({ audio_url / channel: "tts" })
    S->>R: withRetry(fn, 'STT'/'TTS', 3)
    R->>EL: attempt 1
    EL-->>R: Error { statusCode: 503 }
    Note over R: status 503 → retriable
    Note over R: wait 500ms
    R->>EL: attempt 2
    EL-->>R: Error { statusCode: 503 }
    Note over R: status 503 → retriable
    Note over R: wait 1000ms
    R->>EL: attempt 3
    EL-->>R: { text: "test audio transcription" }
    R-->>S: result (sttAttempts = 3)
    S-->>T: { decoded_text, language }
    Note over T: expect(mockState.sttAttempts).toBe(3)

    Note over T,EL: Scenario B — 402 fast-fail (no retries)

    T->>S: execute({ audio_url / channel: "tts" })
    S->>R: withRetry(fn, 'STT'/'TTS', 3)
    R->>EL: attempt 1
    EL-->>R: Error { statusCode: 402, message: "paid_plan_required" }
    Note over R: status 402 → 4xx, not 429 → fast-fail immediately
    R-->>S: throws "[STT] non-retriable (HTTP 402): paid_plan_required"
    S-->>T: rejects
    Note over T: expect(attempts).toBe(1)

    Note over T,EL: Scenario C — all 3 attempts fail (exhaustion)

    T->>S: execute({ audio_url / channel: "tts" })
    S->>R: withRetry(fn, 'STT'/'TTS', 3)
    R->>EL: attempt 1
    EL-->>R: Error { statusCode: 503 }
    Note over R: wait 500ms
    R->>EL: attempt 2
    EL-->>R: Error { statusCode: 503 }
    Note over R: wait 1000ms
    R->>EL: attempt 3
    EL-->>R: Error { statusCode: 503 }
    Note over R: maxAttempts reached
    R-->>S: throws "[STT] failed after 3 attempts: transient server error"
    S-->>T: rejects
    Note over T: expect(attempts).toBe(3)
```

---

## Sequence Diagram 2 — Pre-Guardrail Data Layer

Shows the bureau fetch through the read-through resolver and how `masked_profile` is constructed and passed downstream.

```mermaid
sequenceDiagram
    participant W as Mastra Workflow
    participant PG as preGuardrailStep
    participant FS as FastAPI Sidecar
    participant R1 as Redis L1
    participant R2 as MongoDB L2
    participant R3 as Snowflake L3

    W->>PG: execute({ decoded_text })
    Note right of PG: getInitData returns mobile

    Note over PG: normalizeMobile → 10-digit user_id
    Note over PG: INJECTION_PATTERNS → no match
    Note over PG: SCOPE_PATTERNS → no match

    PG->>FS: GET /internal/bureau/9876543210

    FS->>R1: JSON.GET cc:profile:9876543210
    alt L1 hit (TTL valid)
        R1-->>FS: { user_id, general_info, pii, ... }
        FS-->>PG: 200 OK — full bureau profile
    else L1 miss
        R1-->>FS: null
        FS->>R2: find({ _id: "9876543210:Oct-2025" })
        alt L2 hit (within 15-day freshness window)
            R2-->>FS: full bureau doc
            FS->>R1: JSON.SET cc:profile:9876543210 (TTL)
            FS-->>PG: 200 OK — full bureau profile
        else L2 miss or stale
            R2-->>FS: null / stale
            FS->>R3: SELECT OBJECT_CONSTRUCT WHERE MOBILE = user_id
            R3-->>FS: flat UPPERCASE row { SCORE, PL_OUTSTANDING, ... }
            Note over FS: normalizer maps flat row to categorized bureau JSON
            FS->>R2: insertOne({ _id: "9876543210:Oct-2025", ... })
            FS->>R1: JSON.SET cc:profile:9876543210 (PII-stripped, TTL)
            FS-->>PG: 200 OK — full bureau profile (includes PII)
        end
    end

    Note over PG: maskProfilePii(profile)
    Note over PG: mobile  "9876543210" → "98XXXX3210"
    Note over PG: pan     "ABCDE1234F" → "ABCXXXX34F"
    Note over PG: aadhaar "444455556666" → "XXXXXXXX6666"

    PG-->>W: { pre_guardrail: true, decoded_text, masked_profile }

    Note over W: masked_profile passed to LLM context\nraw PII never reaches the model
```

---

## Error Handling & Try/Catch Strategy

### `withRetry` — shared utility (`src/mastra/lib/retry.ts`)

```
withRetry<T>(fn, label, maxAttempts = 3)
  attempt 1..maxAttempts:
    try:
      return await fn()
    catch err:
      status = err.statusCode ?? err.status
      if status in [400–499] AND status != 429:
        throw immediately — "[label] non-retriable (HTTP status): message"
      if attempt < maxAttempts:
        warn + sleep(500 * attempt)   ← 500ms, 1000ms
  throw — "[label] failed after N attempts: message"
```

| HTTP status | Action | Reason |
|---|---|---|
| 5xx | Retry | Transient server error |
| 429 | Retry | Rate limit — back off and retry |
| 402 | Fast-fail | Billing/plan issue — retrying is futile |
| 401, 403 | Fast-fail | Auth/permission — retrying won't help |
| 400 | Fast-fail | Bad request — caller must fix input |
| Network error (no status) | Retry | Connection drop may be transient |

### Per-step error handling

| Step | Where | Strategy | Notes |
|---|---|---|---|
| `decodeStep` | STT call | `withRetry(..., 'STT')` | Bun-safe Buffer upload for local files |
| `decodeStep` | missing key | throw before retry | `ELEVENLABS_API_KEY` guard — immediate fail |
| `composeStep` | TTS call | `withRetry(..., 'TTS')` | Empty stream → `err.statusCode = 500` → triggers retry |
| `preGuardrailStep` | bureau fetch | `try { ... } catch {}` | **Silent swallow** — bureau fetch is non-blocking; guardrail purpose is filtering, not identity. Missing profile → `masked_profile = undefined`, workflow continues |
| `postGuardrailStep` | PII redact | no throws | Pure string transform; cannot fail |
| `composeStep` (WA/web) | channel format | no throws | Pure string transform; cannot fail |

### Why pre-guardrail swallows bureau errors silently

The guardrail step's primary job is to block injection and out-of-scope queries. The bureau fetch is best-effort context enrichment for the downstream LLM. A sidecar timeout or network hiccup must not block a valid user query — the LLM can still respond without the profile. The error is intentionally not logged to avoid leaking user IDs to stdout.

---

## Bugs Fixed

| # | Bug | Root Cause | Fix |
|---|---|---|---|
| 1 | `.env` API key corrupted | `ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID` on one line — Bun parsed the entire line as the key value (`sk_...TRnaQb7q41oL7sV0w6Bu`) | Split onto two separate lines in `.env` |
| 2 | STT `createReadStream` fails in Bun | ElevenLabs SDK detects `RUNTIME.type === "bun"` and skips the Node.js `Readable` branch; `createReadStream` result is not a `ReadableStream` and is rejected as "Unsupported stream type: object" | `readFileSync` → `Buffer` + `WithMetadata { data, contentType, filename }` — SDK's `isBuffer` path works in both runtimes |
| 3 | Global `/g` regex `lastIndex` silent miss | Exported regex constants with the `g` flag retain `lastIndex` between calls; second call to `.replace()` starts mid-string and misses matches | `new RegExp(pattern.source, 'g')` constructed per call in `postGuardrailStep` |
| 4 | `mockState` bleed across test files | `mock.module` and `global.fetch` are shared for the entire `bun test` run; retry tests set `ttsFailUntilAttempt = 99`, leaving integration tests with a permanently failing TTS mock | `afterAll` in `steps.test.ts` resets all mockState fields and restores `global.fetch = originalFetch` |
| 5 | Integration TTS tests ran with mock | `mock.module` is global — integration tests received the mock's 16-byte buffer (24 chars base64) and passed length checks incorrectly | `hasElevenLabs` now requires `sk_` prefix; mock context uses `test-key` so integration tests skip automatically |
| 6 | Bureau integration tests auto-ran | `.env` has sidecar config but sidecar not started → `fetch` throws → `masked_profile = undefined` → test fails on `toBeDefined()` | `hasBureau` requires explicit `BUREAU_LIVE=true` flag in addition to the URL/secret env vars |
| 7 | Simran voice 402 not retried | `TRnaQb7q41oL7sV0w6Bu` (Simran) is a paid ElevenLabs library voice — throws HTTP 402 | `withRetry` correctly fast-fails on 402. Fix: use `JBFqnCBsd6RMkjVDRZzb` (George, free tier) in `ELEVENLABS_VOICE_ID` |

---

## Test Results

```
bun test src/mastra/__tests__

 steps.test.ts      ████████████████████ 86 pass  9 skip
 tools.test.ts      ████████████████████  9 pass
 patterns.test.ts   ████████████████████  3 pass

 Total: 98 pass · 9 skip · 0 fail
```

### What the 9 skips are

| Count | Guard | Condition to un-skip |
|---|---|---|
| 3 | `it.skipIf(!hasElevenLabs)` | `ELEVENLABS_API_KEY` starts with `sk_` (real key, not mock `test-key`) |
| 2 | `it.skipIf(!hasElevenLabs \|\| !hasAudioUrl)` | Real key + `TEST_AUDIO_URL` set |
| 4 | `it.skipIf(!hasBureau)` | `BUREAU_LIVE=true` + `BUREAU_SIDECAR_URL` + `INTERNAL_API_SECRET` + `TEST_MOBILE` |

### Live probe confirmation (run manually)

```
[1] Voices — George (JBFqnCBsd6RMkjVDRZzb) found in account
[2] TTS happy path — PASS (using George voice, free tier)
[3] TTS retry simulation — succeeded on attempt 3 after 2 simulated 503s
[4] TTS fast-fail — PASS — threw after 1 attempt (402), did not retry
[5] STT local file — PASS
    language: en (raw: eng)
    text: "How is my credit history? Please check out my complete profile and give a overview."
```

---

## Outstanding (Issue 004)

- `src/mastra/tools/eligibility.ts` — credit card eligibility decision tree (blocked on workflow wiring; `identityCheckStep` does not provide `bureau_profile` directly — bureau data comes via `getBureauProfile` tool)
- `ELEVENLABS_VOICE_ID` — set to `JBFqnCBsd6RMkjVDRZzb` (George) for free tier; upgrade to paid plan to use Simran (`TRnaQb7q41oL7sV0w6Bu`) or another library voice
- `memory-writeback.ts` — currently a no-op skeleton; full persistence logic pending Issue 004
