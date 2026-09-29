/// <reference types="node" />
/**
 * Live multi-turn session probe — drive a scripted conversation (one or more messages) through the
 * whole credix workflow on a SINGLE session, and nest every turn under one root span so the whole
 * conversation shows up as ONE Honeycomb trace.
 *
 * Nothing is mocked: real Hono `app` -> fetchBureau (Python bureau sidecar) -> understand (real Grok)
 * -> specialist (real Grok + tools) -> post-guardrail -> memory-writeback (OM) -> compose. Requires the
 * sidecar reachable at BUREAU_SIDECAR_URL and a real mobile that HAS a bureau record.
 *
 * You edit the mobile/messages in `probe.local.json` (gitignored — it holds a real number = PII):
 *   { "mobile": "9876543210", "messages": ["turn 1", "turn 2", "turn 3"], "channel": "web" }
 * A single "message" string still works as a one-turn run. Set "session_id" to continue a prior
 * conversation across runs; omit it to start fresh (a UUID is generated and reused for all turns).
 *
 * Run (from src/mastra/ — tracing.ts must be imported BEFORE app code, exactly like `dev`):
 *   bun run probe
 * or explicitly:
 *   node --env-file-if-exists=../../.env --import tsx/esm --import ./tracing.ts scripts/probe-turn.ts
 *
 * All turns share one root span (probe.session), so the printed trace_id is the whole conversation.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { trace, context } from '@opentelemetry/api'

const INPUT = fileURLToPath(new URL('../probe.local.json', import.meta.url))

type ProbeInput = {
  mobile?: string
  messages?: string[]
  message?: string
  channel?: string
  session_id?: string
}

function loadInput(): { mobile: string; messages: string[]; channel: string; session_id?: string } {
  let raw: string
  try {
    raw = readFileSync(INPUT, 'utf8')
  } catch {
    console.error(
      `[probe] missing ${INPUT}\nCreate it (it is gitignored):\n` +
        `  { "messages": ["How can I improve my credit score?", "Which matters most?"], "channel": "web" }`,
    )
    process.exit(1)
  }
  const parsed = JSON.parse(raw) as ProbeInput
  // Default to TEST_MOBILE from .env, so the number lives in ONE place instead of being copied into a
  // second file. `mobile` in probe.local.json still wins, for probing a specific user ad hoc.
  const mobile = parsed.mobile ?? process.env.TEST_MOBILE
  if (!/^\d{10}$/.test(mobile ?? '')) {
    console.error('[probe] need a 10-digit number: set TEST_MOBILE in .env, or "mobile" in probe.local.json')
    process.exit(1)
  }
  // Back-compat: a single "message" string is treated as a one-turn conversation.
  const messages = parsed.messages ?? (parsed.message ? [parsed.message] : [])
  if (!Array.isArray(messages) || messages.length === 0 || !messages.every(m => typeof m === 'string' && m.trim())) {
    console.error('[probe] provide "messages" (non-empty array of non-empty strings) or a "message" string')
    process.exit(1)
  }
  return {
    mobile: mobile as string,
    messages,
    channel: parsed.channel ?? 'web',
    session_id: parsed.session_id,
  }
}

async function main() {
  const input = loadInput()
  // Import AFTER tracing.ts has booted (via --import) so auto-instrumentation is in place.
  const { app } = (await import('../server')) as {
    app: { request: (p: string, init: RequestInit) => Promise<Response> }
  }

  // One session across all turns → same memory thread → OM accumulates turn over turn.
  const sessionId = input.session_id ?? crypto.randomUUID()

  const tracer = trace.getTracer('probe')
  // Root span: the whole conversation. Every turn nests under it → one trace_id.
  const sessionSpan = tracer.startSpan('probe.session')
  sessionSpan.setAttribute('app.session.id', sessionId) // random UUID, not PII
  sessionSpan.setAttribute('app.session.turns', input.messages.length)
  const traceId = sessionSpan.spanContext().traceId
  const sessionCtx = trace.setSpan(context.active(), sessionSpan)

  console.log(`\n[probe] session ${sessionId} — ${input.messages.length} turn(s), channel ${input.channel}\n`)

  const startedAll = performance.now()
  for (let i = 0; i < input.messages.length; i++) {
    const message = input.messages[i]
    // Per-turn span under the session root. Run the request inside its context so credix.workflow
    // for this turn nests here — all turns share the session's trace_id.
    const turnSpan = tracer.startSpan('probe.turn', undefined, sessionCtx)
    turnSpan.setAttribute('app.turn.index', i) // never the raw message text (may contain PII)
    const turnCtx = trace.setSpan(sessionCtx, turnSpan)

    const started = performance.now()
    const res = await context.with(turnCtx, () =>
      app.request('/v1/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mobile: input.mobile, message, channel: input.channel, session_id: sessionId }),
      }),
    )
    const elapsedMs = Math.round(performance.now() - started)
    const json = (await res.json()) as Record<string, unknown>
    turnSpan.setAttribute('app.probe.status', res.status)
    turnSpan.setAttribute('app.probe.elapsed_ms', elapsedMs)
    if (typeof json.active_skill === 'string') turnSpan.setAttribute('app.active_skill', json.active_skill)
    turnSpan.end()

    console.log(`──── turn ${i + 1}/${input.messages.length} ────`)
    console.log(`  > ${message}`)
    console.log('  status      ', res.status, `(${elapsedMs}ms)`)
    console.log('  active_skill', json.active_skill)
    if (json.degraded) console.log('  degraded    ', json.degraded, json.error_code ?? '')
    if (json.error) console.log('  error       ', json.error, '| detail:', json.detail ?? '(none)')
    console.log('  response    ', json.response)
    console.log('')
  }
  const totalMs = Math.round(performance.now() - startedAll)
  sessionSpan.setAttribute('app.session.elapsed_ms', totalMs)
  sessionSpan.end()

  console.log('──────────────────────────────')
  console.log('session_id   ', sessionId)
  console.log('total        ', `${totalMs}ms across ${input.messages.length} turn(s)`)
  console.log('trace_id     ', traceId)
  console.log('→ Honeycomb: service credix-mastra, paste this trace_id into trace search.')
  console.log('  ONE trace: probe.session -> N probe.turn -> each with its own credix.workflow subtree.')
  console.log('  Per turn: understand.classify + agent.generate durations, app.tool_calls.count.')
  console.log('  Across turns: om.writeback (app.om.pending_tokens / app.om.observed) should grow as')
  console.log('  the conversation crosses the observation threshold.\n')

  // The batch processor exports every OTEL_BSP_SCHEDULE_DELAY (2s in .env). Wait past one cycle so the
  // spans are flushed to Honeycomb before the process exits.
  const flushWait = Number(process.env.OTEL_BSP_SCHEDULE_DELAY ?? 2000) + 1500
  console.log(`[probe] waiting ${flushWait}ms for span export…`)
  await new Promise((r) => setTimeout(r, flushWait))

  // Langfuse is a SEPARATE pipeline from the OTel wait above and needs its own flush, for the same
  // reason server.ts flushes on SIGTERM/SIGINT: each turn's root span ends last, so exiting without
  // this loses the trace-level record (name, input, output) while the child spans survive.
  try {
    const { observability } = await import('../index')
    const instances = observability?.listInstances()
    if (instances) for (const inst of instances.values()) await inst.flush()
    console.log('[probe] Langfuse spans flushed')
  } catch (err) {
    console.warn('[probe] Langfuse flush error', err)
  }
  process.exit(0)
}

main().catch((err) => {
  console.error('[probe] failed:', err)
  process.exit(1)
})
