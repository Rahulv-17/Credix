/**
 * OpenTelemetry SDK bootstrap for the credix Hono server. Sends traces to Honeycomb (or a local
 * OTel Collector) over OTLP/HTTP.
 *
 * This file MUST be loaded BEFORE any application code so auto-instrumentation can patch `http`,
 * `undici` (Node 20 `fetch`), etc. before they are imported. It is wired via `--import` in the
 * package.json run scripts, after the tsx ESM loader:
 *
 *   node --import tsx/esm --import ./tracing.ts server.ts
 *
 * All OTLP wiring comes from environment variables (the exporter reads them itself):
 *   OTEL_SERVICE_NAME=credix-mastra
 *   OTEL_EXPORTER_OTLP_ENDPOINT=https://api.honeycomb.io      (or http://localhost:4318 for the local collector)
 *   OTEL_EXPORTER_OTLP_HEADERS="x-honeycomb-team=<INGEST_KEY>" (omit for the local collector)
 *
 * Honeycomb silently drops OTLP data that lacks the x-honeycomb-team header, so the header is
 * required when pointing at api.honeycomb.io. Traces route by service.name; no dataset header needed.
 */
import { NodeSDK } from '@opentelemetry/sdk-node'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node'

// `dev` boots this file by default, so degrade gracefully when OTLP is not configured (fresh clone,
// CI, or a run without .env): without an endpoint OR headers the exporter would default to
// localhost:4318 and spam connection-refused every batch. Skip starting the SDK instead and tell the
// operator how to point it at Honeycomb. Use `dev:untraced` to run with no tracing at all.
const otlpConfigured = Boolean(
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_HEADERS,
)
if (!otlpConfigured) {
  console.warn(
    '[tracing] OTLP not configured (no OTEL_EXPORTER_OTLP_ENDPOINT / _HEADERS) — tracing disabled. ' +
      'Set them in .env to export to Honeycomb, or run `dev:untraced` to silence this.',
  )
}

const sdk = otlpConfigured
  ? new NodeSDK({
      // Endpoint + headers are read from OTEL_EXPORTER_OTLP_* by the exporter.
      traceExporter: new OTLPTraceExporter(),
      instrumentations: [
        getNodeAutoInstrumentations({
          // fs spans are extremely noisy and never interesting for this service.
          '@opentelemetry/instrumentation-fs': { enabled: false },
          // Connection-setup spans (dns.lookup / tcp.connect / tls.connect) clutter every LLM turn
          // with depth-4/5 noise and never explain app latency here (keep-alive reuses connections).
          '@opentelemetry/instrumentation-dns': { enabled: false },
          '@opentelemetry/instrumentation-net': { enabled: false },
          '@opentelemetry/instrumentation-undici': {
            // PII: the internal sidecar paths embed the user's 10-digit mobile
            // (/internal/bureau/<mobile>, /internal/user-story/<mobile>). The auto undici span would
            // record that mobile in url.full / url.path. Skip the auto span for every internal call;
            // our PII-safe `bureau.fetch` / `user-story.fetch` custom spans cover them.
            ignoreRequestHook: (req: { path?: string }) =>
              (req.path ?? '').startsWith('/internal/'),
            // Every outbound LLM + web call is otherwise named just "POST", so a turn's waterfall is a
            // wall of identical rows. Rename + tag by target so master (gemini pro) vs worker (gemini
            // flash) vs Exa is legible at a glance. Model + method already live in url.full; we lift
            // them onto app.llm.* so they are filterable. Never throw into the request path.
            requestHook: (
              span: { updateName: (name: string) => void; setAttribute: (k: string, v: string) => void },
              req: { origin?: string; path?: string; method?: string },
            ) => {
              try {
                // Google Generative Language path: /v1beta/models/<model>:<method>
                const gemini = (req.path ?? '').match(/\/models\/([^:/?]+):(\w+)/)
                if (gemini) {
                  const [, model, method] = gemini
                  span.updateName(`llm ${model}`)
                  span.setAttribute('app.llm.provider', 'google')
                  span.setAttribute('app.llm.model', model)
                  span.setAttribute('app.llm.method', method) // generateContent | streamGenerateContent
                  return
                }
                let host = req.origin ?? ''
                try {
                  host = new URL(req.origin ?? '').hostname
                } catch {
                  /* origin not a full URL; keep it as-is */
                }
                if (host.includes('exa.ai')) {
                  span.updateName('exa.search')
                  span.setAttribute('app.http.api', 'exa')
                  return
                }
                // Fallback: never leave a bare "POST" / "GET". Qualify every other outbound call by its
                // host (e.g. ElevenLabs TTS -> "POST api.elevenlabs.io") so the waterfall stays legible.
                if (host) span.updateName(`${req.method ?? 'HTTP'} ${host}`)
              } catch {
                /* instrumentation must never break the request */
              }
            },
          },
        }),
      ],
    })
  : null

if (sdk) {
  sdk.start()
  console.log(
    '[tracing] OpenTelemetry started; exporting to',
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? '(default)',
  )

  // Flush the batch processor on shutdown so the last spans are not lost. Registered with `once` and
  // guarded so it coexists with server.ts's own SIGTERM handler without double-exiting.
  let shuttingDown = false
  const flushAndExit = async (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    try {
      await sdk.shutdown()
      console.log(`[tracing] flushed on ${signal}`)
    } catch (err) {
      console.warn('[tracing] shutdown error', err)
    }
  }
  process.once('SIGTERM', () => void flushAndExit('SIGTERM'))
  process.once('SIGINT', () => void flushAndExit('SIGINT'))
}
