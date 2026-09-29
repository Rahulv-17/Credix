/// <reference types="bun-types" />
import { describe, it, expect, afterEach } from 'bun:test'
import { buildSslConfig, getCatalogPool, resetCatalogPoolForTests } from '../lib/catalog-db'

// The catalog DB TLS posture is security-sensitive: production must never SILENTLY fall back to
// unauthenticated TLS. These pin the opt-in ladder so a regression can't quietly re-enable MITM.
describe('buildSslConfig', () => {
  const KEYS = ['DB_SSL_CA', 'DB_SSL_VERIFY', 'DB_SSL_INSECURE', 'NODE_ENV'] as const
  const saved: Record<string, string | undefined> = {}
  for (const k of KEYS) saved[k] = process.env[k]
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })
  const clear = () => {
    for (const k of KEYS) delete process.env[k]
  }

  it('DB_SSL_VERIFY=1 authenticates against the system store', () => {
    clear()
    process.env.DB_SSL_VERIFY = '1'
    expect(buildSslConfig()).toEqual({ rejectUnauthorized: true })
  })

  it('dev/test default is unverified (low friction), not a throw', () => {
    clear()
    process.env.NODE_ENV = 'test'
    expect(buildSslConfig()).toEqual({ rejectUnauthorized: false })
  })

  it('production REFUSES to silently downgrade: throws without an explicit opt-in', () => {
    clear()
    process.env.NODE_ENV = 'production'
    expect(() => buildSslConfig()).toThrow(/unauthenticated/i)
  })

  it('production allows unverified TLS only with the explicit DB_SSL_INSECURE=1 opt-in', () => {
    clear()
    process.env.NODE_ENV = 'production'
    process.env.DB_SSL_INSECURE = '1'
    expect(buildSslConfig()).toEqual({ rejectUnauthorized: false })
  })
})

// resetCatalogPoolForTests must best-effort close an existing pool, not just orphan it, so a real
// pg.Pool doesn't leak connections / keep the process alive across tests.
describe('resetCatalogPoolForTests', () => {
  const savedUrl = process.env.DATABASE_URL
  const savedNodeEnv = process.env.NODE_ENV
  afterEach(() => {
    resetCatalogPoolForTests()
    if (savedUrl === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = savedUrl
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = savedNodeEnv
  })

  it('closes the cached pool (no throw) and drops the reference so the next call rebuilds', () => {
    process.env.NODE_ENV = 'test'
    // A real pg.Pool is lazy (no socket until first query), so building + end()ing it here is offline.
    process.env.DATABASE_URL = 'postgresql://u:p@127.0.0.1:5432/nodb'
    const p1 = getCatalogPool()
    expect(p1).not.toBeNull()
    expect(getCatalogPool()).toBe(p1) // memoised
    expect(() => resetCatalogPoolForTests()).not.toThrow() // calls p1.end() best-effort
    expect(getCatalogPool()).not.toBe(p1) // reference dropped, fresh pool built
  })

  it('is a no-op when no pool was ever built', () => {
    delete process.env.DATABASE_URL
    resetCatalogPoolForTests()
    expect(getCatalogPool()).toBeNull() // cached=null branch, still no throw
    expect(() => resetCatalogPoolForTests()).not.toThrow()
  })
})
