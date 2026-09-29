/**
 * Tiny in-process TTL cache with a size bound, shared by the bureau + user-story fetch layers so a
 * multi-turn conversation reuses a per-user payload instead of hitting the sidecar every turn.
 * Ephemeral: memory only, never logged, never persisted, dies with the process.
 *
 * `ttlMs <= 0` or `max <= 0` disables the cache (get always misses, set is a no-op). Otherwise `max`
 * bounds the map so a long-lived process serving many users cannot grow it without limit: at
 * capacity, expired entries are evicted first, then the oldest insertion.
 */
type Entry<T> = { value: T; expiresAt: number }

export type TtlCache<T> = {
  get(key: string): T | undefined
  set(key: string, value: T): void
  clear(): void
}

/**
 * Parse a non-negative-integer env var, falling back to `def` when it is unset OR non-numeric.
 * Without this a typo like `BUREAU_CACHE_MAX=foo` becomes `NaN` and silently breaks both guards:
 * `size >= NaN` is always false (the map grows unbounded) and `NaN <= 0` is false (the disable
 * switch never engages). Keeping 0 valid preserves the documented `*_TTL_MS=0` disable semantics.
 */
export function envInt(name: string, def: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return def
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : def
}

export function ttlCache<T>(ttlMs: number, max: number): TtlCache<T> {
  const store = new Map<string, Entry<T>>()
  return {
    get(key) {
      if (ttlMs <= 0 || max <= 0) return undefined
      const hit = store.get(key)
      if (hit && hit.expiresAt > Date.now()) return hit.value
      if (hit) store.delete(key) // expired
      return undefined
    },
    set(key, value) {
      if (ttlMs <= 0 || max <= 0) return
      if (store.size >= max && !store.has(key)) {
        const now = Date.now()
        for (const [k, e] of store) if (e.expiresAt <= now) store.delete(k)
        if (store.size >= max) {
          const oldest = store.keys().next().value
          if (oldest !== undefined) store.delete(oldest)
        }
      }
      store.set(key, { value, expiresAt: Date.now() + ttlMs })
    },
    clear() {
      store.clear()
    },
  }
}
