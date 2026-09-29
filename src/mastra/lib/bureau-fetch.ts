/**
 * Single source of truth for calling the bureau sidecar. Centralises the URL shape, the
 * `X-Internal-Token` header, and `encodeURIComponent(user_id)` so the fetch block is no longer
 * duplicated across server.ts / pre-guardrail.ts / identity-check.ts (closes Sudhanshu review #3).
 *
 * Never logs the URL or user_id — the path embeds the user_id (a 10-digit mobile), which is PII.
 *
 * Reuse across turns: a user's bureau document is immutable per scrub-month (the resolver has a
 * 15-day freshness window) and is keyed only by user_id, so within a short window the same result is
 * safe to reuse. We keep a small in-process TTL cache keyed by user_id so a multi-turn conversation
 * fetches once and reuses it, instead of hitting the sidecar every turn. The cache is ephemeral
 * (memory only, never logged, never persisted, dies with the process) — deliberately NOT working
 * memory or LibSQL, which must not hold raw bureau PII at rest (see memory/index.ts).
 *
 * Returns a discriminated result so callers branch without inspecting raw Response objects:
 *   { ok: true,  profile }          — 200, PII-stripped bureau profile
 *   { ok: false, notFound: true }   — 404, no bureau record for this user
 *   { ok: false, status }           — any other non-2xx, or a transport error (status 0)
 */
import { tracer, recordError } from './otel'
import { ttlCache, envInt } from './ttl-cache'

export type BureauFetchResult =
  | { ok: true; profile: Record<string, unknown> }
  | { ok: false; notFound: true }
  | { ok: false; status: number }

// In-process reuse window. BUREAU_CACHE_TTL_MS=0 disables the cache (always fetch). CACHE_MAX bounds
// memory so a long-lived process serving many users cannot grow the map without limit.
const cache = ttlCache<Record<string, unknown>>(
  envInt('BUREAU_CACHE_TTL_MS', 900_000),
  envInt('BUREAU_CACHE_MAX', 1000),
)

/** Test hook: drop all cached profiles so cases don't bleed into each other. */
export function clearBureauCache(): void {
  cache.clear()
}

export async function fetchBureau(user_id: string): Promise<BureauFetchResult> {
  const sidecarUrl = process.env.BUREAU_SIDECAR_URL ?? 'http://localhost:8000'
  const token = process.env.INTERNAL_API_SECRET ?? ''
  // Custom span: classifies the bureau call outcome so it is aggregable in Honeycomb (group by
  // app.bureau.result / app.bureau.cache). NEVER record user_id / the URL — the path embeds the
  // mobile (PII).
  return tracer.startActiveSpan('bureau.fetch', async (span): Promise<BureauFetchResult> => {
    try {
      // Cache hit: reuse the profile fetched earlier this window, no sidecar call.
      const hit = cache.get(user_id)
      if (hit) {
        span.setAttribute('app.bureau.cache', 'hit')
        span.setAttribute('app.bureau.result', 'ok')
        return { ok: true, profile: hit }
      }
      span.setAttribute('app.bureau.cache', 'miss')

      const res = await fetch(`${sidecarUrl}/internal/bureau/${encodeURIComponent(user_id)}`, {
        headers: { 'X-Internal-Token': token },
      })
      span.setAttribute('app.bureau.http_status', res.status)
      if (res.status === 404) {
        span.setAttribute('app.bureau.result', 'not_found')
        return { ok: false, notFound: true }
      }
      if (!res.ok) {
        span.setAttribute('app.bureau.result', 'error')
        return { ok: false, status: res.status }
      }
      span.setAttribute('app.bureau.result', 'ok')
      const profile = (await res.json()) as Record<string, unknown>
      // Only ok profiles are cached — not_found / error / unreachable must re-try next turn.
      cache.set(user_id, profile)
      return { ok: true, profile }
    } catch (err) {
      // Transport error (sidecar down / DNS / network). status 0 = unreachable.
      span.setAttribute('app.bureau.result', 'unreachable')
      span.setAttribute('app.bureau.http_status', 0)
      recordError(span, err, 'err-bureau-unreachable')
      return { ok: false, status: 0 }
    } finally {
      span.end()
    }
  })
}
