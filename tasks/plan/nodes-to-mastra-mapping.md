# Python Nodes → Mastra Migration Map

`src/nodes/` is the Python data sidecar. `src/mastra/` is the TypeScript agent layer.
This table shows what each Python module was, what it became, and what's still Python-only.

---

## Pipeline nodes (LangGraph → Mastra steps)

| Python (`src/nodes/graph/nodes/`) | TypeScript (`src/mastra/steps/`) | Status |
|---|---|---|
| `decode.py` — NFC normalize, language detect | `decode.ts` — `decodeStep` | Issue 002 |
| `pre_guardrail.py` — injection + scope filter | `pre-guardrail.ts` — `preGuardrailStep` | Issue 002 |
| `understand.py` — Grok LLM, intent + entity extract | `understand.ts` — `understandStep` | Issue 003 |
| `identity_check.py` — mobile normalize, bureau load | `identity-check.ts` — `identityCheckStep` | Issue 003 |
| `post_guardrail.py` — PII scrub on LLM output | `post-guardrail.ts` — `postGuardrailStep` | Issue 002 |
| `memory_writeback.py` — persist goals/summary to store | `memory-writeback.ts` — `memoryWritebackStep` | Issue 004 |
| `user_story.py` — compose user-story context block | `user-story.ts` — stub | Issue 004 |
| `skill_resolver.py` — route by intent | `workflows/credix-workflow.ts` — `.branch()` | Issue 004 |

---

## Specialists (LangGraph subgraphs → Mastra agents)

| Python (`src/nodes/graph/specialists/`) | TypeScript (`src/mastra/agents/`) | Status |
|---|---|---|
| `credit_card/graph.py` | `credit-card.ts` | Issue 003 |
| `insurance/graph.py` | `insurance.ts` | Issue 003 |
| `score_improvement/graph.py` | `score-improvement.ts` | Issue 003 |
| _(missing — fallback)_ | `credix.ts` — general responder | Issue 003 |

---

## Tools (Python `@tool` → Mastra `createTool`)

| Python (`src/nodes/tools/`) | TypeScript (`src/mastra/tools/`) | Status |
|---|---|---|
| `decision_trees/card_eligibility.py` | `eligibility.ts` — `checkCardEligibility` | Issue 002 |
| `deterministic_engine/emi.py` | `calculators.ts` — `calculateEmi` | Issue 002 |
| `deterministic_engine/foir.py` | `calculators.ts` — `calculateFoir` | Issue 002 |
| `deterministic_engine/dbr.py` | `calculators.ts` — `calculateDbr` | Issue 003 |
| `deterministic_engine/interest.py` | `calculators.ts` — `calculateInterest` | Issue 003 |
| `deterministic_engine/refinance.py` | pending | Issue 003 |
| `decision_trees/score_improvement.py` | pending | Issue 003 |
| `prediction_models/approval_likelihood.py` | pending | Issue 003 |
| `prediction_models/policy_gate.py` | pending | Issue 003 |
| `product_catalog/ranker.py` + `search.py` | pending | Issue 003 |
| `policy_rules_kb/` | pending | Issue 003 |
| `raw_data/bureau/factory.py` + `resolver.py` | `tools/bureau.ts` — HTTP sidecar call | Issue 003 |

---

## Guardrails (Python → Mastra patterns + steps)

| Python (`src/nodes/guardrails/`) | TypeScript | Status |
|---|---|---|
| `injection_filter.py` — regex list | `lib/patterns.ts` — `INJECTION_PATTERNS` | Done (Issue 001) |
| `scope_filter.py` — regex list | `lib/patterns.ts` — `SCOPE_PATTERNS` | Done (Issue 001) |
| `pii_scrubber.py` — PAN/Aadhaar/mobile regex | `steps/post-guardrail.ts` + `lib/patterns.ts` | Issue 002 |
| `content_policy.py` — numeric output rule | `lib/patterns.ts` comment + synthesizer logic | Issue 002 |
| `numeric_traceability.py` — digit-only assertion | `steps/compose.ts` — `toTts()` guard | Issue 002 |

---

## Infrastructure (Python FastAPI → Hono sidecar)

| Python (`src/nodes/api/`) | TypeScript (`src/mastra/server.ts`) | Status |
|---|---|---|
| `app.py` — FastAPI app | `server.ts` — Hono app | Done (Issue 001) |
| `routes/bureau_internal.py` — `/internal/bureau/:id` | still served by Python sidecar | Stays Python |
| `middleware/auth.py` — token auth | `server.ts` — `X-Internal-Token` check | Done (Issue 001) |
| `middleware/rate_limit.py` | pending | Issue 005+ |
| `middleware/request_id.py` | pending | Issue 005+ |

---

## Stays Python-only (data sidecar, no TypeScript port planned)

| Module | Role |
|---|---|
| `raw_data/bureau/` — Redis/Mongo/Snowflake resolver | Bureau data pipeline; TypeScript calls it via HTTP |
| `raw_data/user_memory/` — goals, constraints, transcripts | Memory store; Mastra memory layer wraps it |
| `raw_data/precomputed/` — derived metrics, eligibility cache | Batch jobs, not request-path |
| `raw_data/user_data/` — declared values, store | User self-reported data |
| `memory/` — assembler, checkpoint, postgres/redis store | Session persistence layer |
| `observability/` — audit, logging, metrics, tracing | Stays Python; Mastra has its own telemetry |
| `workers/` — background write, precompute refresh | Async workers, Python only |
| `common/` — errors, types, utils, ids | Shared Python utilities |
| `persona/synthesizer.py`, `rahul.py`, `style_guide.py` | Persona logic migrated to `compose.ts`; originals archived |
| `llm/grok_client.py` | Superseded by `lib/provider.ts` (deleted in Issue 001) |

---

## Key invariants carried across the boundary

- `mobile_to_user_id()` logic in `raw_data/bureau/tokenizer.py` is mirrored in `server.ts:normalizeUserId()` — keep in sync
- Redis key format `cc:profile:{user_id}` is owned by Python; TypeScript reads via HTTP only
- PII is never logged on either side — Python guardrails strip at write time; Mastra strips at output time
- Numeric output (money, scores, %) always as digits — enforced by `composeStep.toTts()` and `numeric_traceability.py`
