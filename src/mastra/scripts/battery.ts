/// <reference types="node" />
/**
 * Persona battery — the measurement instrument for the right-card flow port (Phase 0).
 *
 * Drives scripted conversations through the REAL /v1/chat (same path as probe-turn.ts: Hono app ->
 * bureau sidecar -> master -> workers -> guardrails -> compose), logs every turn to
 * scratchpad/battery-<stamp>.jsonl, and runs deterministic checks for the defect classes we already
 * know about. Ported working practice from ../right-card, where hand-graded batteries produced the
 * defect list that drove 25 prompt commits.
 *
 * What this adds over their hand-grading: the checks below are regex, so the same run is comparable
 * before and after a change. A check REPORTS a match; it does not decide severity. Human grading of
 * the jsonl still lands in tasks/fix-queue.md — some flags are legitimate (e.g. "one question" trips
 * the spelled-number probe).
 *
 * Run (from src/mastra/, needs the bureau sidecar up and TEST_MOBILE in .env):
 *   bun run battery                 # both suites, ~15 min of live turns
 *   bun run battery -- --suite=single --limit=4     # smoke run first
 *
 * Costs real model tokens on every turn. Do not leave it looping.
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { SINGLE, MULTI } from './battery-cases'
import { AADHAAR_PATTERN, MOBILE_PATTERN, PAN_PATTERN } from '../lib/patterns'
import { scrubIdentifiers } from '../lib/otel'

const arg = (name: string) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : undefined
}
const SUITE = (arg('suite') ?? 'all') as 'single' | 'multi' | 'all'
const LIMIT = Number(arg('limit') ?? Infinity)

// Validated in main(), not at module scope: a bare process.exit here made the file impossible to import,
// which is what kept scrubRow below untested.
const MOBILE = process.env.TEST_MOBILE

// ── Checks ────────────────────────────────────────────────────────────────────────────────────────
// Each returns the matched text (evidence for the grader) or null. Ordered by how much we care.
type Check = { id: string; why: string; run: (reply: string, ctx: CheckCtx) => string | null }
type CheckCtx = { previousReplies: string[] }

const INTERNAL_VOCAB = [
  // our own signal taxonomy, which leaked verbatim in the 2026-08-03 probe ("prime segment, thick file")
  'thick file', 'thin file', 'prime segment', 'file tier', 'file_tier', 'compose signal', 'tier1', 'tier2',
  // plumbing right-card's adversary case pulled out of their bot (their F6)
  'catalog', 'database', 'supabase', 'sidecar', 'tool call', 'getcard', 'getsignals', 'getbureau',
  // jargon their agents are forbidden from saying to a user
  'income floor', 'score floor', 'net value', 'bucket', 'hard constraint', 'foir', 'ntc',
]

const SPELLED_NUMBER =
  /\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|lakh|lakhs|crore|crores)\b/gi

const CHECKS: Check[] = [
  {
    id: 'pii',
    why: 'PAN / Aadhaar / full mobile must never appear in a reply',
    // The constants are already compiled and all carry /g/, so they are used directly rather than rebuilt
    // per reply. Safe with String.match specifically, which resets lastIndex; [0] is the first match either
    // way, so the evidence string is unchanged (PR #20 review).
    run: (r) => r.match(PAN_PATTERN)?.[0] ?? r.match(AADHAAR_PATTERN)?.[0] ?? r.match(MOBILE_PATTERN)?.[0] ?? null,
  },
  {
    id: 'announce-tool',
    why: 'observed 2026-08-03: replies opened with "I\'ll pull..." / "I\'ll get..." before the answer',
    run: (r) => r.match(/^\s*(I'?ll|I will|Let me|Let's|Allow me|Give me a moment)\b[^.!?]*[.!?]/i)?.[0] ?? null,
  },
  {
    id: 'glued-text',
    why: 'observed 2026-08-03: "you.HDFC" — master concatenating instead of synthesizing',
    run: (r) => r.match(/[a-z][.!?][A-Z][a-z]/)?.[0] ?? null,
  },
  {
    id: 'internal-vocab',
    why: 'internal taxonomy and plumbing words must not reach the user (right-card F6)',
    run: (r) => {
      const lower = r.toLowerCase()
      const hit = INTERNAL_VOCAB.find((w) => lower.includes(w))
      return hit ?? null
    },
  },
  {
    id: 'dash',
    why: 'persona rule: no em dash, en dash, or hyphen as a separator (TTS reads them badly)',
    run: (r) => r.match(/[—–]|(?<=\s)-(?=\s)/)?.[0] ?? null,
  },
  {
    id: 'over-length',
    why: 'persona rule: 120 words, 200 only for an explicit full rundown',
    run: (r) => {
      const words = r.split(/\s+/).filter(Boolean).length
      return words > 120 ? `${words} words` : null
    },
  },
  {
    id: 'repeat-sentence',
    why: 'right-card M2: the same ask or line written twice in one reply was endemic',
    run: (r) => {
      const seen = new Set<string>()
      for (const s of r.split(/(?<=[.!?])\s+/)) {
        const k = s.trim().toLowerCase().replace(/[^a-z0-9 ]/g, '')
        if (k.length < 25) continue
        if (seen.has(k)) return s.trim().slice(0, 80)
        seen.add(k)
      }
      return null
    },
  },
  {
    id: 'repeat-reply',
    why: 'right-card: never resend a prior turn\'s reply, and never re-serve one answer to a changed question',
    run: (r, ctx) => {
      const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 400)
      return ctx.previousReplies.some((p) => norm(p) === norm(r)) ? 'identical to an earlier turn' : null
    },
  },
  {
    id: 'no-question',
    why: 'both repos require ending on one focused next step; a reply with no question usually dead-ends',
    run: (r) => (r.includes('?') ? null : 'no question in reply'),
  },
  {
    id: 'spelled-number',
    why: 'persona rule: digits only. NOTE noisy — "one question", "one line" trip it legitimately',
    run: (r) => r.match(SPELLED_NUMBER)?.[0] ?? null,
  },
]

// ── Runner ────────────────────────────────────────────────────────────────────────────────────────
const stamp = process.env.BATTERY_STAMP ?? String(process.hrtime.bigint()).slice(0, 10)
const LOG_DIR = fileURLToPath(new URL('../../../scratchpad/', import.meta.url))
const LOG = `${LOG_DIR}battery-${stamp}.jsonl`
// mkdirSync lives in main(), not here: this file is imported by battery-scrub.test.ts, and importing a
// module should not create directories (PR #20 review).

type Row = {
  suite: 'single' | 'multi'
  case_id: string
  persona: string
  turn: number
  session_id: string
  message: string
  status: number
  latency_ms: number
  active_skill?: string
  degraded?: boolean
  error_code?: string
  reply: string
  flags: { id: string; evidence: string }[]
  watch: string
}

const tally = new Map<string, number>()

/**
 * Redact hard identifiers from everything that lands on disk, using the same helper the telemetry path
 * uses (lib/otel.ts). `scratchpad/` is gitignored, which is NOT the same as scrubbed: the whole point of
 * the `pii` check is that a reply can contain a PAN, and both `reply` and that check's own `evidence`
 * would otherwise persist it in plaintext, in the log and in any backup of it (PR #20 review).
 *
 * Applied at the DISK BOUNDARY on purpose, never before the checks run. A check has to see the real PAN
 * to flag it, so scrubbing earlier would silently turn the `pii` check into one that can never fire, and
 * `repeat-reply` compares against replies held in memory, which must stay like for like. Returns a new
 * row rather than mutating, so the caller's in-memory copy is untouched.
 *
 * CIBIL scores deliberately survive: they are 3-digit numbers and lib/otel.ts does not scrub them, which
 * is what makes the log gradeable at all.
 */
export function scrubRow(row: Row): Row {
  return {
    ...row,
    message: scrubIdentifiers(row.message),
    reply: scrubIdentifiers(row.reply),
    flags: row.flags.map((f) => ({ id: f.id, evidence: scrubIdentifiers(f.evidence) })),
  }
}

async function runTurn(
  app: { request: (p: string, init: RequestInit) => Promise<Response> },
  opts: { suite: 'single' | 'multi'; case_id: string; persona: string; turn: number; session_id: string; message: string; watch: string; previousReplies: string[] },
): Promise<Row> {
  const t0 = Date.now()
  const res = await app.request('/v1/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mobile: MOBILE, message: opts.message, channel: 'web', session_id: opts.session_id }),
  })
  const latency_ms = Date.now() - t0
  const json = (await res.json()) as Record<string, unknown>
  const reply = typeof json.response === 'string' ? json.response : `<no response: ${JSON.stringify(json).slice(0, 200)}>`

  const flags = CHECKS.map((c) => {
    const evidence = c.run(reply, { previousReplies: opts.previousReplies })
    return evidence ? { id: c.id, evidence } : null
  }).filter(Boolean) as { id: string; evidence: string }[]
  for (const f of flags) tally.set(f.id, (tally.get(f.id) ?? 0) + 1)

  const row: Row = {
    suite: opts.suite,
    case_id: opts.case_id,
    persona: opts.persona,
    turn: opts.turn,
    session_id: opts.session_id,
    message: opts.message,
    status: res.status,
    latency_ms,
    active_skill: typeof json.active_skill === 'string' ? json.active_skill : undefined,
    degraded: json.degraded === true || undefined,
    error_code: typeof json.error_code === 'string' ? json.error_code : undefined,
    reply,
    flags,
    watch: opts.watch,
  }
  appendFileSync(LOG, `${JSON.stringify(scrubRow(row))}\n`)
  const flagStr = flags.length ? `  FLAGS ${flags.map((f) => f.id).join(',')}` : ''
  console.log(`  ${opts.case_id}.${opts.turn} [${opts.persona}] ${res.status} ${latency_ms}ms${flagStr}`)
  return row
}

async function main() {
  if (!MOBILE || !/^\d{10}$/.test(MOBILE)) {
    console.error('[battery] TEST_MOBILE must be a 10-digit number in .env')
    process.exit(1)
  }
  mkdirSync(LOG_DIR, { recursive: true })
  const { app } = (await import('../server')) as { app: { request: (p: string, init: RequestInit) => Promise<Response> } }
  console.log(`[battery] log: ${LOG}\n[battery] suite=${SUITE} limit=${LIMIT}\n`)
  const started = Date.now()
  let turns = 0

  if (SUITE !== 'multi') {
    console.log('── single-turn suite ──')
    for (const c of SINGLE.slice(0, LIMIT)) {
      // Fresh session per case: single-turn cases must not inherit each other's conversation memory.
      await runTurn(app, { suite: 'single', case_id: c.id, persona: c.persona, turn: 1, session_id: `bat-${stamp}-${c.id}`, message: c.message, watch: c.watch, previousReplies: [] })
      turns++
    }
  }

  if (SUITE !== 'single') {
    console.log('\n── multi-turn suite ──')
    for (const c of MULTI.slice(0, LIMIT)) {
      const session_id = `bat-${stamp}-${c.id}`
      const previousReplies: string[] = []
      for (let i = 0; i < c.turns.length; i++) {
        const row = await runTurn(app, { suite: 'multi', case_id: c.id, persona: c.persona, turn: i + 1, session_id, message: c.turns[i]!, watch: c.watch, previousReplies: [...previousReplies] })
        previousReplies.push(row.reply)
        turns++
      }
    }
  }

  const mins = ((Date.now() - started) / 60000).toFixed(1)
  console.log(`\n── summary ── ${turns} turns in ${mins} min`)
  if (tally.size === 0) console.log('  no flags')
  for (const [id, n] of [...tally.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(3)}  ${id}  — ${CHECKS.find((c) => c.id === id)!.why}`)
  }
  console.log(`\n[battery] grade the jsonl into tasks/fix-queue.md: ${LOG}`)

  // Same reason probe-turn.ts flushes: each turn's root span ends last, and a bare exit drops it.
  try {
    const { observability } = await import('../index')
    const instances = observability?.listInstances()
    if (instances) for (const inst of instances.values()) await inst.flush()
  } catch (err) {
    console.warn('[battery] Langfuse flush error', err)
  }
  process.exit(0)
}

// Only when run directly (`bun run battery`). Importing this file must not start a live 45-turn run,
// which is what lets scrubRow be tested. Compared on argv rather than `import.meta.main`, which needs
// Node >= 24.2 and this repo pins no version, so on an older one that property is simply undefined and
// the battery would silently never run.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) void main()
