# Test Results — Issue 002

**Date:** 2026-06-25  
**Branch:** `dev`  
**Runner:** bun test v1.3.14  
**Scope:** Unit tests only (patterns, steps, tools)

---

## Summary

| File | Tests | Pass | Fail | Skip | Time |
|---|---|---|---|---|---|
| `__tests__/patterns.test.ts` | 53 | 53 | 0 | 0 | ~35ms |
| `__tests__/steps.test.ts` | 31 | 31 | 0 | 0 | ~974ms |
| `__tests__/tools.test.ts` | 8 | 8 | 0 | 0 | ~321ms |
| **Total** | **92** | **92** | **0** | **0** | **~972ms** |

```
bun test v1.3.14 (0d9b296a)

 92 pass
 0 fail
 133 expect() calls
Ran 92 tests across 3 files. [972.00ms]
```

JUnit XML: `tasks/test-results-issue-002.xml`

---

## Integration tests (`__tests__/integration.test.ts`)

Run separately — requires live API credentials and a running bureau sidecar.

**Status:** 6 skip, 2 fail, 0 pass  
**Reason for failures:** Two known issues —

1. **Mock bleed** — `mock.module('@elevenlabs/elevenlabs-js')` in `steps.test.ts` persists
   for the lifetime of the bun process. When `integration.test.ts` runs in the same invocation,
   the TTS calls hit the mock instead of the real API (`Buffer.from('mock-audio-bytes')` = 24
   base64 chars, well below the `> 1000` threshold). Always run integration tests in isolation:
   ```bash
   bun test __tests__/integration.test.ts
   ```

2. **ElevenLabs API key** — the key in `.env` returned 401 (`invalid_api_key`). Replace with a
   valid key before running integration tests.

**To run integration tests properly:**
```bash
ELEVENLABS_API_KEY=<valid-key> \
ELEVENLABS_VOICE_ID=JBFqnCBsd6RMkjVDRZzb \
BUREAU_SIDECAR_URL=http://localhost:8000 \
INTERNAL_API_SECRET=changeme \
TEST_MOBILE=9876543210 \
bun test __tests__/integration.test.ts
```

---

## Typecheck

```bash
cd src/mastra && bun run typecheck  # exit 0
```
