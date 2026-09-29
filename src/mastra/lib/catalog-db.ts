import { Pool } from 'pg'
import { readFileSync } from 'node:fs'

/**
 * Card catalog Postgres connection.
 *
 * First cut reuses Cred's Supabase catalog directly (the low-friction path): the card tools query
 * the SAME database Cred's filtering backend uses, so card facts and the reward math have one source
 * of truth. This is reversible — point DATABASE_URL at a Credix-owned catalog later, or swap this
 * for an endpoint + fetch client (like lib/bureau-fetch.ts), without touching the tools.
 *
 * Card reference data is PUBLIC product information, so it does NOT pass the PII firewall. Only
 * user-specific ranking inputs (income, spend) are sensitive, and those live in the bureau/signals
 * layers, never here.
 *
 * The pool is built LAZILY (getCatalogPool) so importing a card tool never crashes when DATABASE_URL
 * is unset (bun test, a fresh clone); tools check for null and fail soft with CATALOG_DB_UNAVAILABLE.
 */

export const CATALOG_DB_UNAVAILABLE =
  'The card catalog database is not configured (DATABASE_URL is unset). ' +
  'Add the Supabase Postgres connection string to the repo-root .env, then restart.'

export function buildSslConfig() {
  // Supabase's pooler presents a cert chain Node's default trust store rejects, so verification is
  // opt-in: DB_SSL_CA=<path> verifies against the bundled CA (the real fix); DB_SSL_VERIFY=1 verifies
  // against the system store.
  const caPath = process.env.DB_SSL_CA
  if (caPath) return { rejectUnauthorized: true, ca: readFileSync(caPath, 'utf8') }
  if (process.env.DB_SSL_VERIFY === '1') return { rejectUnauthorized: true }
  // Unauthenticated TLS (encrypted but not authenticated) is now an explicit opt-in. In production we
  // refuse to silently downgrade: fail loudly unless DB_SSL_INSECURE=1 is set, so a misconfigured
  // prod env can't quietly become MITM-able. Dev and test keep the low-friction unverified default.
  if (process.env.DB_SSL_INSECURE === '1') return { rejectUnauthorized: false }
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'Catalog DB TLS would be unauthenticated. Set DB_SSL_CA=<path> or DB_SSL_VERIFY=1 to ' +
        'authenticate the connection, or DB_SSL_INSECURE=1 to explicitly allow unverified TLS.',
    )
  }
  return { rejectUnauthorized: false }
}

let cached: Pool | null | undefined

export function getCatalogPool(): Pool | null {
  if (cached !== undefined) return cached
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    cached = null
    return cached
  }
  const pool = new Pool({
    connectionString,
    ssl: buildSslConfig(),
    max: 5,
    idleTimeoutMillis: 30000,
  })
  // node-postgres emits 'error' on the Pool when an IDLE client's connection drops (Supabase recycles
  // idle connections routinely); with no listener Node treats it as unhandled and crashes the whole
  // process, taking down every in-flight request. Logging it lets the pool transparently replace the
  // dead client on the next query.
  pool.on('error', (err) => {
    console.error('[catalog-db] pool error (idle client dropped) — recovering:', err.message)
  })
  cached = pool
  return cached
}

/** Test seam: drop the memoised pool so a test can re-evaluate DATABASE_URL / a fresh pg mock. */
export function resetCatalogPoolForTests(): void {
  // Best-effort close a real pool before dropping the reference, so connections don't leak (and keep
  // the process alive) across tests. The StubPool used by unit tests has no end(); the guard skips it.
  const pool = cached
  if (pool && typeof (pool as { end?: unknown }).end === 'function') {
    void (pool as Pool).end().catch(() => {})
  }
  cached = undefined
}
