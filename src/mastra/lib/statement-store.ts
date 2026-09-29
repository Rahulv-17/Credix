import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'

// File-backed store for parsed, chunked statement documents, keyed by user_id. The interface parses
// a PDF, chunks it to JSON, and POSTs it to /v1/statement; the ingest handler calls putStatement,
// which writes <STATEMENT_STORE_DIR>/<user_id>.json. The getStatement tool and makeAgentStep read it
// back. A file (not an in-memory Map) so it survives restarts AND is visible to every process that
// runs the agent — the Hono server (:3000), Mastra Studio (:2024), and `mastra build` output all
// resolve the same directory, so an upload on one is readable by an agent on another.
//
// Override the location with STATEMENT_STORE_DIR; otherwise it sits next to the mastra package so
// cwd differences between processes never split the store.

export interface StatementChunk {
  id: string
  index: number
  heading: string
  text: string
  chars: number
}

export interface StatementDocument {
  meta: { source: string; pages: number | null; chars: number; uploadedAt: string }
  chunks: StatementChunk[]
}

const STORE_DIR =
  process.env.STATEMENT_STORE_DIR ??
  resolve(dirname(fileURLToPath(import.meta.url)), '..', '.statement-store')

function ensureDir(): void {
  if (!existsSync(STORE_DIR)) mkdirSync(STORE_DIR, { recursive: true })
}

// user_id is normalized to 10 digits upstream; sanitize anyway so a bad key can't escape the dir.
function fileFor(userId: string): string {
  const safe = userId.replace(/[^a-zA-Z0-9_-]/g, '')
  return join(STORE_DIR, `${safe}.json`)
}

export function putStatement(userId: string, doc: StatementDocument): void {
  ensureDir()
  writeFileSync(fileFor(userId), JSON.stringify(doc), 'utf8')
}

export function getStatementDoc(userId: string): StatementDocument | null {
  const file = fileFor(userId)
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as StatementDocument
  } catch {
    return null // corrupt/partial file — treat as absent rather than throwing into the agent
  }
}

export function hasStatement(userId: string): boolean {
  return existsSync(fileFor(userId))
}

// Lightweight keyword ranking: score each chunk by how many query terms it contains (heading matches
// weighted higher). Enough for "find the chunk about EMIs / balance" without an embedder.
export function searchStatement(userId: string, query: string, limit = 3): StatementChunk[] {
  const doc = getStatementDoc(userId)
  if (!doc) return []
  const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2)
  if (!terms.length) return doc.chunks.slice(0, limit)
  const scored = doc.chunks.map(c => {
    const hay = `${c.heading}\n${c.text}`.toLowerCase()
    const headHay = c.heading.toLowerCase()
    let score = 0
    for (const t of terms) {
      if (hay.includes(t)) score += 1
      if (headHay.includes(t)) score += 2
    }
    return { c, score }
  })
  return scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(s => s.c)
}
