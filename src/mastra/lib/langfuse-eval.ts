/**
 * Minimal Langfuse eval reporter: a dataset, its items, one trace plus scores per case, and a dataset run
 * item linking item to trace, so a tool-fetch run lands in Langfuse as an experiment you can sort by score.
 *
 * Why direct REST rather than the exporter in lib/langfuse-observability.ts: that path exports spans from
 * AGENT and WORKFLOW runs. A direct tool-fetch check never enters an agent, so it produces no Mastra AI
 * span and there is nothing for the exporter to send. Endpoint shapes were read from the instance's own
 * OpenAPI spec (`GET /generated/api/openapi.yml`), not from memory:
 *   POST /api/public/v2/datasets        { name, description }
 *   GET  /api/public/dataset-items      ?datasetName&limit          (to skip re-upserting on a re-run)
 *   POST /api/public/dataset-items      { datasetName, id, input, expectedOutput, metadata }
 *   POST /api/public/ingestion          { batch: [{ id, type, timestamp, body }] }   trace-create + score-create
 *   POST /api/public/dataset-run-items  { runName, datasetItemId, traceId, metadata }
 *
 * RATE LIMITS are the reason this batches. The first run of a 100-case suite issued ~500 requests and the
 * API returned 429 with `{ limit: 100, retryAfterSeconds }` for every dataset-run-item, so the experiment
 * came out empty while the local results looked fine. Traces and scores are now sent as ingestion BATCHES
 * (300 events in 3 calls instead of 300), dataset items are skipped when they already exist, and every call
 * honours `retryAfterSeconds` on a 429 rather than dropping the write.
 *
 * PII, not to be loosened. The scrub/omit processors in lib/langfuse-observability.ts run on the exporter
 * pipeline, so nothing here inherits them. Callers must pass a fetch VERDICT (field names, non-null counts,
 * a pass/fail reason) and never a raw tool payload: bureau sections, statement chunks and signals are bulk
 * financial data with no identifier pattern to match, which is precisely why the exporter drops those
 * payloads by key instead of scrubbing them. Everything that does leave still goes through scrubIdentifiers.
 *
 * Gating mirrors the exporter: all three env vars, or nothing leaves the process.
 */
import { scrubIdentifiers } from './otel'

const PUBLIC_KEY = process.env.LANGFUSE_PUBLIC_KEY
const SECRET_KEY = process.env.LANGFUSE_SECRET_KEY
const BASE_URL = process.env.LANGFUSE_BASE_URL

export const langfuseEnabled = Boolean(PUBLIC_KEY && SECRET_KEY && BASE_URL)

/** Recursively scrub every string, using the same helper the exporter uses so the two cannot drift. */
function deepScrub(value: unknown): unknown {
  if (typeof value === 'string') return scrubIdentifiers(value)
  if (Array.isArray(value)) return value.map(deepScrub)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = deepScrub(v)
    return out
  }
  return value
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const auth = () => Buffer.from(`${PUBLIC_KEY}:${SECRET_KEY}`).toString('base64')

/**
 * Keys that carry free-form MODEL text rather than a verdict.
 *
 * The rule this file states is "verdict only", and the agent pass broke it by exporting a scrubbed model
 * reply on the reasoning that scrubbing made it safe (PR #20 review). It does not: scrubIdentifiers matches
 * identifier PATTERNS, and "your utilisation is 38% and you owe ₹2,40,000" contains no pattern to match.
 * Bulk financial prose is exactly what the span exporter drops by KEY rather than scrubbing, so the same
 * approach applies here.
 *
 * Enforced at this boundary rather than at each call site, because a comment asking callers to be careful
 * is what failed the first time. Dropped and warned rather than thrown: a run that has already spent live
 * tokens should still publish its scores, and the warning names the key so the author fixes the caller.
 */
const MODEL_TEXT_KEYS = new Set([
  'reply', 'response', 'text', 'message', 'content', 'output', 'completion', 'prose', 'answer', 'transcript',
])

export function verdictForExport(verdict: unknown, caseId: string): unknown {
  if (!verdict || typeof verdict !== 'object' || Array.isArray(verdict)) return verdict
  const out: Record<string, unknown> = {}
  const dropped: string[] = []
  for (const [k, v] of Object.entries(verdict as Record<string, unknown>)) {
    if (MODEL_TEXT_KEYS.has(k.toLowerCase())) dropped.push(k)
    else out[k] = v
  }
  if (dropped.length) {
    console.warn(
      `[langfuse-eval] ${caseId}: dropped ${dropped.join(', ')} from the exported verdict. Model text is ` +
        'not exported; keep it in the local jsonl and send a verdict summary instead.',
    )
  }
  return out
}

type Reply = { ok: boolean; status: number; text: string; json: any }

/**
 * One request, retrying on 429 for the server-stated delay. Capped at 4 attempts: past that, the caller
 * should hear about it rather than have the script sit in a backoff loop.
 */
async function req(method: 'GET' | 'POST', path: string, body?: unknown, attempt = 0): Promise<Reply> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Basic ${auth()}` },
    body: body === undefined ? undefined : JSON.stringify(deepScrub(body)),
  })
  const text = await res.text()
  let json: any = null
  try {
    json = JSON.parse(text)
  } catch {
    /* non-JSON error bodies are kept as text */
  }
  if (res.status === 429 && attempt < 3) {
    // The API tells us how long to wait; guessing an interval is what produced the empty experiment.
    const wait = Number(json?.details?.retryAfterSeconds ?? 5)
    await sleep(Math.min(wait + 1, 30) * 1000)
    return req(method, path, body, attempt + 1)
  }
  return { ok: res.ok, status: res.status, text: text.slice(0, 240), json }
}

export type EvalCase = {
  /** Stable id, reused as the dataset item id so re-runs upsert instead of duplicating. */
  id: string
  tool: string
  input: unknown
  /** What a pass means, in words, so a dataset row reads without the code beside it. */
  expected: string
}

export type EvalResult = {
  passed: boolean
  /** One-line failure reason, or null. Becomes the score comment. */
  reason: string | null
  latencyMs: number
  /** A verdict summary. NEVER the raw payload; see the PII note above. */
  verdict: unknown
  /** Extra dimension for the experiment view, e.g. 'pass' | 'fail' | 'nodata'. */
  verdictLabel: string
}

/** Create the dataset and upsert only the items that are not already there. */
export async function ensureDataset(
  name: string,
  description: string,
  cases: EvalCase[],
): Promise<{ created: number; skipped: number; errors: string[] }> {
  const errors: string[] = []
  const ds = await req('POST', '/api/public/v2/datasets', { name, description })
  if (!ds.ok) errors.push(`dataset: ${ds.status} ${ds.text}`)

  // Existing ids first, so a re-run costs 1 request instead of 100 and leaves rate-limit headroom for the
  // run items, which are the writes that actually populate the experiment.
  const existing = new Set<string>()
  const list = await req('GET', `/api/public/dataset-items?datasetName=${encodeURIComponent(name)}&limit=100`)
  if (list.ok && Array.isArray(list.json?.data)) for (const it of list.json.data) if (it?.id) existing.add(it.id)

  let created = 0
  let skipped = 0
  for (const c of cases) {
    if (existing.has(c.id)) {
      skipped++
      continue
    }
    const item = await req('POST', '/api/public/dataset-items', {
      datasetName: name,
      id: c.id,
      input: { tool: c.tool, args: c.input },
      expectedOutput: c.expected,
      metadata: { tool: c.tool },
    })
    if (item.ok) created++
    else errors.push(`item ${c.id}: ${item.status} ${item.text}`)
  }
  return { created, skipped, errors }
}

/** A trace id per case, so scores and run items can reference it before anything is sent. */
export function traceIdsFor(cases: EvalCase[]): Map<string, string> {
  return new Map(cases.map((c) => [c.id, crypto.randomUUID()]))
}

/**
 * Send every trace and score in batched ingestion calls.
 *
 * `tool_fetch_ok` is the BOOLEAN an experiment view aggregates (spec: boolean score values must be exactly
 * 1 or 0). `tool_latency_ms` rides alongside as NUMERIC so a slow-but-passing fetch is visible rather than
 * invisible, and `tool_verdict` is CATEGORICAL so 'nodata' can be told apart from a real failure.
 */
export async function ingestTracesAndScores(
  cases: EvalCase[],
  results: Map<string, EvalResult>,
  traceIds: Map<string, string>,
  runName: string,
  batchSize = 100,
): Promise<string[]> {
  const events: unknown[] = []
  const now = new Date().toISOString()
  for (const c of cases) {
    const r = results.get(c.id)
    if (!r) continue
    const traceId = traceIds.get(c.id)!
    events.push({
      id: crypto.randomUUID(),
      type: 'trace-create',
      timestamp: now,
      body: {
        id: traceId,
        name: `tool:${c.tool}`,
        input: { tool: c.tool, args: c.input },
        output: verdictForExport(r.verdict, c.id),
        metadata: { case_id: c.id, tool: c.tool, expected: c.expected, latency_ms: r.latencyMs, run: runName },
        tags: ['tool-fetch', c.tool, r.verdictLabel],
        environment: 'tool-battery',
      },
    })
    events.push({
      id: crypto.randomUUID(),
      type: 'score-create',
      timestamp: now,
      body: {
        id: crypto.randomUUID(),
        traceId,
        name: 'tool_fetch_ok',
        value: r.passed ? 1 : 0,
        dataType: 'BOOLEAN',
        comment: r.reason ?? 'fetched the expected details',
        environment: 'tool-battery',
      },
    })
    events.push({
      id: crypto.randomUUID(),
      type: 'score-create',
      timestamp: now,
      body: {
        id: crypto.randomUUID(),
        traceId,
        name: 'tool_latency_ms',
        value: r.latencyMs,
        dataType: 'NUMERIC',
        environment: 'tool-battery',
      },
    })
    events.push({
      id: crypto.randomUUID(),
      type: 'score-create',
      timestamp: now,
      body: {
        id: crypto.randomUUID(),
        traceId,
        name: 'tool_verdict',
        value: r.verdictLabel,
        dataType: 'CATEGORICAL',
        environment: 'tool-battery',
      },
    })
  }

  const errors: string[] = []
  for (let i = 0; i < events.length; i += batchSize) {
    const chunk = events.slice(i, i + batchSize)
    const res = await req('POST', '/api/public/ingestion', { batch: chunk })
    if (!res.ok) errors.push(`ingestion[${i}..${i + chunk.length}]: ${res.status} ${res.text}`)
    // Langfuse reports per-event failures inside a 2xx envelope, so a 200 is not proof it all landed.
    else if (Array.isArray(res.json?.errors) && res.json.errors.length) {
      errors.push(`ingestion[${i}] ${res.json.errors.length} event errors: ${JSON.stringify(res.json.errors[0]).slice(0, 160)}`)
    }
  }
  return errors
}

/** File each case under the run. No batch endpoint exists for these, so they go one at a time with backoff. */
export async function linkRunItems(
  datasetName: string,
  runName: string,
  cases: EvalCase[],
  results: Map<string, EvalResult>,
  traceIds: Map<string, string>,
): Promise<string[]> {
  const errors: string[] = []
  for (const c of cases) {
    const r = results.get(c.id)
    if (!r) continue
    const res = await req('POST', '/api/public/dataset-run-items', {
      runName,
      runDescription: 'Direct tool-fetch coverage: does each tool actually return its details',
      datasetItemId: c.id,
      traceId: traceIds.get(c.id),
      metadata: { verdict: r.verdictLabel, tool: c.tool },
    })
    if (!res.ok) errors.push(`runItem ${c.id}: ${res.status} ${res.text}`)
  }
  return errors
}
