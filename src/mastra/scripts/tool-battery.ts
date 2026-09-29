/// <reference types="node" />
/**
 * Tool-fetch coverage battery: does every tool actually FETCH its details from the real source?
 *
 * Distinct from scripts/battery.ts, which drives conversations through /v1/chat and grades the REPLY.
 * This calls each tool's execute() directly against the real catalog DB, the real bureau sidecar and the
 * real Exa API, so a failure names one tool and one field instead of a sentence the model wrote. The two
 * are complementary: this proves the tool CAN fetch, the /v1/chat pass proves the model CHOOSES it.
 *
 * A case fails when the tool returns its not-found or unavailable shape for input verified to exist. "No
 * exception thrown" is not the bar; the bar is that the details came back.
 *
 * Run from src/mastra (the root .env is loaded by the package script):
 *   bun run tool-battery                    # all cases, plus Langfuse if configured
 *   bun run tool-battery -- --need=catalog  # only catalog cases, skip sidecar and Exa
 *   bun run tool-battery -- --no-langfuse   # local only
 *
 * Langfuse: each case becomes a trace with a tool_fetch_ok score, filed under a dataset run so it shows up
 * as an experiment. Only a fetch VERDICT is exported, never a raw payload; see lib/langfuse-eval.ts.
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { TOOL_CASES, type Need, type ToolCase } from './tool-battery-cases'
import { scrubIdentifiers } from '../lib/otel'
import {
  ensureDataset, ingestTracesAndScores, linkRunItems, traceIdsFor, langfuseEnabled,
  type EvalResult,
} from '../lib/langfuse-eval'

import { getSignals } from '../tools/signals'
import { checkCardEligibility } from '../tools/eligibility'
import { exaSearch } from '../tools/exa'
import { getBureauProfile, getBureauDetail } from '../tools/bureau'
import { calculateEmi, calculateFoir } from '../tools/calculators'
import { getStatement } from '../tools/statement'
import {
  getCardCriteria, getCardFees, getCardPartnerRates, getCardBenefits,
  getCardDetails, compareCards, getCardFullProfile,
} from '../tools/card-catalog'

const TOOLS: Record<string, { execute: (input: any, ctx?: any) => Promise<any> }> = {
  getSignals, checkCardEligibility, exaSearch, getBureauProfile, getBureauDetail,
  calculateEmi, calculateFoir, getStatement, getCardCriteria, getCardFees,
  getCardPartnerRates, getCardBenefits, getCardDetails, compareCards, getCardFullProfile,
} as any

const arg = (name: string) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : undefined
}
const flag = (name: string) => process.argv.includes(`--${name}`)
const ONLY_NEED = arg('need') as Need | undefined
const LIMIT = Number(arg('limit') ?? Infinity)
const USE_LANGFUSE = !flag('no-langfuse') && langfuseEnabled

/**
 * The user-scoped tools read user_id from the request context, exactly as server.ts supplies it. This is
 * the same shape RequestContext exposes (a get(key) lookup), so the tools take the context-first path
 * rather than the arg fallback, which is what production does.
 */
const MOBILE = process.env.TEST_MOBILE
const requestContext = { get: (k: string) => (k === 'user_id' ? MOBILE : undefined) }

/** `nodata` = the tool behaved correctly but the underlying data does not exist for the test user. Kept
 *  separate from `fail` so an empty statement cannot masquerade as a broken tool. */
type Verdict = 'pass' | 'fail' | 'error' | 'nodata'
type Row = {
  case_id: string
  tool: string
  needs: Need
  verdict: Verdict
  reason: string | null
  latency_ms: number
  /** Shape only, never the payload: keys plus which came back non-null. */
  shape: Record<string, string>
}

/**
 * Summarise a tool result as a SHAPE, not content. This is what lands in the log and in Langfuse, and it
 * is deliberate: bureau sections, statement chunks and signals are bulk financial data, which is why the
 * Langfuse exporter omits those payloads by key rather than scrubbing them. A shape summary answers "did
 * it fetch" without exporting anyone's finances.
 */
function shapeOf(r: unknown): Record<string, string> {
  if (r === null) return { _: 'null' }
  if (typeof r !== 'object') return { _: typeof r === 'string' ? `string(${r.length})` : typeof r }
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(r as Record<string, unknown>).slice(0, 24)) {
    out[k] =
      v === null ? 'null'
      : Array.isArray(v) ? `array(${v.length})`
      : typeof v === 'object' ? `object(${Object.keys(v as object).length})`
      : typeof v === 'string' ? `string(${v.length})`
      : typeof v
  }
  return out
}

const stamp = process.env.BATTERY_STAMP ?? new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
const LOG_DIR = fileURLToPath(new URL('../../../scratchpad/', import.meta.url))
const LOG = `${LOG_DIR}tool-battery-${stamp}.jsonl`

async function runCase(c: ToolCase): Promise<Row> {
  const tool = TOOLS[c.tool]
  const t0 = Date.now()
  if (!tool) {
    return { case_id: c.id, tool: c.tool, needs: c.needs, verdict: 'error', reason: `no such tool exported: ${c.tool}`, latency_ms: 0, shape: {} }
  }
  try {
    const result = await tool.execute(c.input, { requestContext })
    const latency_ms = Date.now() - t0
    const reason = c.check(result)
    const nodata = Boolean(reason) && Boolean(c.nodataWhen?.(result))
    return {
      case_id: c.id, tool: c.tool, needs: c.needs,
      verdict: nodata ? 'nodata' : reason ? 'fail' : 'pass',
      reason: reason ? scrubIdentifiers(reason) : null,
      latency_ms, shape: shapeOf(result),
    }
  } catch (err) {
    // A throw is its own category. The tools are written to fail soft and return an `error` field, so an
    // exception reaching here is a different defect from a tool that reports it could not fetch.
    return {
      case_id: c.id, tool: c.tool, needs: c.needs, verdict: 'error',
      reason: scrubIdentifiers(err instanceof Error ? err.message : String(err)).slice(0, 200),
      latency_ms: Date.now() - t0, shape: {},
    }
  }
}

async function main() {
  const cases = TOOL_CASES.filter((c) => (ONLY_NEED ? c.needs === ONLY_NEED : true)).slice(0, LIMIT)
  const needsUser = cases.some((c) => c.needs === 'user')
  if (needsUser && (!MOBILE || !/^\d{10}$/.test(MOBILE))) {
    console.error('[tool-battery] user-scoped cases need a 10-digit TEST_MOBILE in .env; use --need=catalog to skip them')
    process.exit(1)
  }
  mkdirSync(LOG_DIR, { recursive: true })

  const runName = `tool-fetch-${stamp}`
  const datasetName = 'credix-tool-fetch'
  console.log(`[tool-battery] ${cases.length} cases  log=${LOG}`)
  console.log(`[tool-battery] langfuse=${USE_LANGFUSE ? `on, dataset '${datasetName}' run '${runName}'` : 'off'}\n`)

  if (USE_LANGFUSE) {
    const ds = await ensureDataset(datasetName, 'Does each tool actually fetch its details from the real source', cases)
    console.log(`[tool-battery] langfuse dataset: ${ds.created} items created, ${ds.skipped} already present`)
    if (ds.errors.length) console.warn(`  dataset warnings (${ds.errors.length}):\n  ${ds.errors.slice(0, 4).join('\n  ')}`)
  }

  // Run every case first, THEN report. Reporting per case cost 4 requests each and burned the API rate
  // limit, so the traces landed and all 100 run items came back 429 while the local table looked healthy.
  const rows: Row[] = []
  for (const c of cases) {
    const row = await runCase(c)
    rows.push(row)
    appendFileSync(LOG, `${JSON.stringify(row)}\n`)
    const mark = { pass: 'PASS', fail: 'FAIL', error: 'ERR ', nodata: 'NODATA' }[row.verdict]
    console.log(`  ${mark.padEnd(6)} ${row.case_id.padEnd(18)} ${row.tool.padEnd(22)} ${String(row.latency_ms).padStart(5)}ms${row.reason ? `  ${row.reason}` : ''}`)
  }

  const lfErrors: string[] = []
  if (USE_LANGFUSE) {
    const results = new Map<string, EvalResult>(
      rows.map((r) => [
        r.case_id,
        {
          passed: r.verdict === 'pass',
          reason: r.reason,
          latencyMs: r.latency_ms,
          verdictLabel: r.verdict,
          verdict: { verdict: r.verdict, reason: r.reason, shape: r.shape },
        },
      ]),
    )
    const traceIds = traceIdsFor(cases)
    console.log(`\n[tool-battery] reporting ${cases.length} cases to langfuse (batched; run items are paced by the API)`)
    lfErrors.push(...(await ingestTracesAndScores(cases, results, traceIds, runName)))
    lfErrors.push(...(await linkRunItems(datasetName, runName, cases, results, traceIds)))
  }

  // ── summary, per tool, because "83 of 100" does not tell you which tool to open ──────────────────
  const byTool = new Map<string, { pass: number; fail: number; error: number; nodata: number }>()
  for (const r of rows) {
    const t = byTool.get(r.tool) ?? { pass: 0, fail: 0, error: 0, nodata: 0 }
    t[r.verdict]++
    byTool.set(r.tool, t)
  }
  const count = (v: Verdict) => rows.filter((r) => r.verdict === v).length
  const pass = count('pass')
  const fail = count('fail')
  const error = count('error')
  const nodata = count('nodata')

  console.log(`\n── per tool ──`)
  for (const [tool, t] of [...byTool.entries()].sort((a, b) => b[1].fail + b[1].error - (a[1].fail + a[1].error))) {
    const total = t.pass + t.fail + t.error + t.nodata
    const notes = [t.fail ? `${t.fail} fail` : '', t.error ? `${t.error} error` : '', t.nodata ? `${t.nodata} nodata` : '']
      .filter(Boolean)
      .join(', ')
    console.log(`  ${tool.padEnd(22)} ${t.pass}/${total}${notes ? `  <-- ${notes}` : ''}`)
  }

  if (fail + error + nodata) {
    console.log(`\n── everything that did not pass ──`)
    for (const r of rows.filter((x) => x.verdict !== 'pass')) {
      console.log(`  [${r.verdict}] ${r.case_id} (${r.tool}): ${r.reason}`)
    }
  }

  const latencies = rows.map((r) => r.latency_ms).sort((a, b) => a - b)
  const p50 = latencies[Math.floor(latencies.length / 2)] ?? 0
  console.log(`\n── total ── ${pass} pass, ${fail} fail, ${error} error, ${nodata} nodata, of ${rows.length}. latency p50 ${p50}ms, max ${latencies.at(-1)}ms`)
  if (lfErrors.length) console.warn(`\n[tool-battery] ${lfErrors.length} langfuse errors, first few:\n  ${lfErrors.slice(0, 5).join('\n  ')}`)
  else if (USE_LANGFUSE) console.log(`[tool-battery] langfuse: dataset '${datasetName}', run '${runName}'`)
  console.log(`[tool-battery] log: ${LOG}`)

  // Same reason battery.ts flushes: spans opened by the tools end last and a bare exit drops them.
  try {
    const { observability } = await import('../index')
    const instances = observability?.listInstances()
    if (instances) for (const inst of instances.values()) await inst.flush()
  } catch {
    /* observability is optional; a missing instance must not fail the run */
  }
  process.exit(fail + error > 0 ? 1 : 0)
}

// Only when run directly, so importing this file for a test starts nothing. Compared on argv rather than
// import.meta.main, which needs Node >= 24.2 and this repo pins no version (see battery.ts).
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) void main()
