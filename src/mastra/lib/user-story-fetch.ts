/**
 * Single source of truth for calling the bureau sidecar's user-story endpoint, which serves the
 * precomputed, PII-safe signal payload (62 Tier-1 + 34 Tier-2 + a gated compose list). Mirrors
 * lib/bureau-fetch.ts: same URL/header/encode shape, same in-process TTL reuse.
 *
 * Never logs the URL or user_id — the path embeds the user_id (a 10-digit mobile), which is PII.
 *
 * Reuse across turns: signals are deterministic per scrub-month and keyed only by user_id, so a
 * multi-turn conversation fetches once and reuses within the window instead of hitting the sidecar
 * every turn. The cache is ephemeral (memory only, never logged, never persisted, dies with the
 * process). The payload MAY carry exact age and income estimates (approved relaxation) — those
 * stay in this cache and the persona store but must never reach a trace span or a log.
 *
 * Returns a discriminated result so callers branch without inspecting raw Response objects:
 *   { ok: true,  signals }          — 200, PII-safe signal payload
 *   { ok: false, notFound: true }   — 404, no story record for this user
 *   { ok: false, status }           — any other non-2xx, or a transport error (status 0)
 */
import { tracer, recordError } from './otel'
import { ttlCache, envInt } from './ttl-cache'

export type UserStoryResult =
  | { ok: true; signals: Record<string, unknown> }
  | { ok: false; notFound: true }
  | { ok: false; status: number }

// In-process reuse window. USER_STORY_CACHE_TTL_MS=0 disables the cache (always fetch). CACHE_MAX
// bounds memory so a long-lived process serving many users cannot grow the map without limit.
const cache = ttlCache<Record<string, unknown>>(
  envInt('USER_STORY_CACHE_TTL_MS', 900_000),
  envInt('USER_STORY_CACHE_MAX', 1000),
)

/** Test hook: drop all cached signals so cases don't bleed into each other. */
export function clearUserStoryCache(): void {
  cache.clear()
}

/** Read the cached signals for a user without fetching (used by the getSignals tool). */
export function peekUserStory(user_id: string): Record<string, unknown> | undefined {
  return cache.get(user_id)
}

export async function fetchUserStory(user_id: string): Promise<UserStoryResult> {
  const sidecarUrl = process.env.BUREAU_SIDECAR_URL ?? 'http://localhost:8000'
  const token = process.env.INTERNAL_API_SECRET ?? ''
  // Custom span: classifies the story call outcome so it is aggregable in Honeycomb (group by
  // app.story.result / app.story.cache). NEVER record user_id / the URL (path embeds the mobile)
  // and NEVER the raw signal values (exact age / score) — only counts, tiers, and result enums.
  return tracer.startActiveSpan('user-story.fetch', async (span): Promise<UserStoryResult> => {
    try {
      const hit = cache.get(user_id)
      if (hit) {
        span.setAttribute('app.story.cache', 'hit')
        span.setAttribute('app.story.result', 'ok')
        return { ok: true, signals: hit }
      }
      span.setAttribute('app.story.cache', 'miss')

      const res = await fetch(`${sidecarUrl}/internal/user-story/${encodeURIComponent(user_id)}`, {
        headers: { 'X-Internal-Token': token },
      })
      span.setAttribute('app.story.http_status', res.status)
      if (res.status === 404) {
        span.setAttribute('app.story.result', 'not_found')
        return { ok: false, notFound: true }
      }
      if (!res.ok) {
        span.setAttribute('app.story.result', 'error')
        return { ok: false, status: res.status }
      }
      span.setAttribute('app.story.result', 'ok')
      const body = (await res.json()) as { signals?: Record<string, unknown> }
      const signals = (body?.signals ?? {}) as Record<string, unknown>
      // Surface compute cost (stamped by the sidecar) without needing Python OTel. PII-safe number.
      const meta = signals._meta as { compute_ms?: number } | undefined
      if (typeof meta?.compute_ms === 'number') {
        span.setAttribute('app.story.compute_ms', meta.compute_ms)
      }
      // Only ok payloads are cached — not_found / error / unreachable must re-try next turn.
      cache.set(user_id, signals)
      return { ok: true, signals }
    } catch (err) {
      span.setAttribute('app.story.result', 'unreachable')
      span.setAttribute('app.story.http_status', 0)
      recordError(span, err, 'err-user-story-unreachable')
      return { ok: false, status: 0 }
    } finally {
      span.end()
    }
  })
}
