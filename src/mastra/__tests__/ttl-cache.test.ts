/// <reference types="bun-types" />
import { describe, it, expect, afterEach } from 'bun:test'
import { envInt, ttlCache } from '../lib/ttl-cache'

/**
 * Guards the shared cache primitive behind bureau-fetch / user-story-fetch. The point of envInt is
 * that a non-numeric env value can no longer become NaN and silently break the eviction bound
 * (`size >= NaN` is always false) or the disable switch (`NaN <= 0` is false).
 */
describe('envInt', () => {
  const KEY = 'TTL_CACHE_TEST_INT'
  afterEach(() => {
    delete process.env[KEY]
  })

  it('parses a valid non-negative integer', () => {
    process.env[KEY] = '1500'
    expect(envInt(KEY, 900_000)).toBe(1500)
  })
  it('falls back to the default when unset', () => {
    expect(envInt(KEY, 900_000)).toBe(900_000)
  })
  it('falls back on a non-numeric value (the NaN guard)', () => {
    process.env[KEY] = 'foo'
    expect(envInt(KEY, 1000)).toBe(1000)
  })
  it('falls back on a negative value', () => {
    process.env[KEY] = '-5'
    expect(envInt(KEY, 1000)).toBe(1000)
  })
  it('keeps 0 (the documented *_TTL_MS=0 disable value)', () => {
    process.env[KEY] = '0'
    expect(envInt(KEY, 900_000)).toBe(0)
  })
})

describe('ttlCache', () => {
  it('stores and returns a value within ttl; misses on unknown keys', () => {
    const c = ttlCache<number>(900_000, 10)
    c.set('a', 1)
    expect(c.get('a')).toBe(1)
    expect(c.get('missing')).toBeUndefined()
  })
  it('ttlMs <= 0 disables: set is a no-op and get always misses', () => {
    const c = ttlCache<number>(0, 10)
    c.set('a', 1)
    expect(c.get('a')).toBeUndefined()
  })
  it('max <= 0 disables: set stores nothing (no lone-entry cache)', () => {
    const c = ttlCache<number>(900_000, 0)
    c.set('a', 1)
    expect(c.get('a')).toBeUndefined()
  })
  it('bounds size at max, evicting the oldest entry', () => {
    const c = ttlCache<number>(900_000, 2)
    c.set('a', 1)
    c.set('b', 2)
    c.set('c', 3) // over capacity → evicts oldest live entry 'a'
    expect(c.get('a')).toBeUndefined()
    expect(c.get('b')).toBe(2)
    expect(c.get('c')).toBe(3)
  })
  it('clear() empties the cache', () => {
    const c = ttlCache<number>(900_000, 10)
    c.set('a', 1)
    c.clear()
    expect(c.get('a')).toBeUndefined()
  })
})
