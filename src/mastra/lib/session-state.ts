/**
 * Per-session conversational state that must survive between turns but not between deploys.
 *
 * Ported shape from ../right-card, which keeps threadAgentState / threadLangState / threadLastQuestion
 * per session rather than reaching for a store.
 *
 * IN-PROCESS ONLY, and that is a real constraint, not an oversight: with more than one server instance
 * a user's turns can land on different processes and this state is lost or inconsistent. Redis is
 * already running for the bureau cache (REDIS_URL), so that is the upgrade path when we scale out. The
 * failure mode is graceful in every case here: a lost language vote means one reply in the previously
 * committed language, a lost sticky agent means one turn routed by the classifier alone.
 */
import { ttlCache, envInt } from './ttl-cache'
import type { LangState } from './language'

/**
 * `${user_id}:${session_id}` -> committed/pending language. Read and written in the /v1/chat handler.
 *
 * The key is COMPOSITE, and any state map added here must use the same one, Phase 4's sticky routing
 * included. session_id is client supplied and nothing forces it to be unique across users, so on a bare
 * session_id the second user reads the first user's state (PR #20 review).
 *
 * Backed by the repo's existing ttlCache rather than a bare Map plus a size guard (PR #20 review). A
 * bare Map evicts by insertion order, and `Map#set` on a key that already exists does NOT move it, so
 * a session active for hours looked exactly as old as one abandoned after its first turn and could be
 * evicted while live. ttlCache deletes EXPIRED entries before it falls back to oldest-inserted, and the
 * handler re-sets this key on every turn, so an active session keeps pushing its expiry out and the
 * idle ones are what go. Residual bound, accepted and the same one the bureau cache lives with: if all
 * `SESSION_STATE_MAX` entries are unexpired at once, the oldest-inserted is still the one dropped.
 */
export const sessionLanguage = ttlCache<LangState>(
  envInt('SESSION_STATE_TTL_MS', 6 * 60 * 60 * 1000),
  envInt('SESSION_STATE_MAX', 5000),
)
