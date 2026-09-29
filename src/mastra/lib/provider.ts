// ── LLM models, picked entirely from env ──────────────────────────────────────────────────────────
// Both ids are Mastra model-router strings ("provider/model"), resolved at generate time. Swap the
// provider by editing MASTER_MODEL / WORKER_MODEL in .env; no code change needed. Keys are read by
// Mastra from the provider's own env var (xai -> XAI_API_KEY, google -> GOOGLE_GENERATIVE_AI_API_KEY).
//
// Default provider is xAI (verified live, tool calling included): master on grok-4.5 (reasoning; it
// writes the user-facing synthesis) and workers + OM Observer/Reflector on grok-4.20-0309-non-reasoning
// (fastest and cheapest of the pair, ~1.4s vs 2.8s per call).
//
// Google stays one env edit away: the shim below forwards GEMINI_API_KEY to the var Mastra's google
// provider reads, so setting MASTER_MODEL=google/... is enough. Never hardcode a secret here.
if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY && process.env.GEMINI_API_KEY) {
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = process.env.GEMINI_API_KEY
}

export const MASTER_MODEL_ID = process.env.MASTER_MODEL ?? 'xai/grok-4.5'
export const WORKER_MODEL_ID = process.env.WORKER_MODEL ?? 'xai/grok-4.20-0309-non-reasoning'
