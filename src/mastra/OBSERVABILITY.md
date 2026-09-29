# Observability (OpenTelemetry → Honeycomb)

The Hono server (`server.ts`) is instrumented with OpenTelemetry. Auto-instrumentation covers the
incoming HTTP server and outbound calls (`fetch`/undici); custom spans wrap the high-value business
operations. Traces export over OTLP/HTTP to Honeycomb (or a local OTel Collector).

## Files

- `tracing.ts` — OTel SDK bootstrap. Loaded via `--import` **before** app code so instrumentation
  can patch `http`/undici. Reads all OTLP config from `OTEL_*` env vars.
- `lib/otel.ts` — `tracer` + `recordError(span, err, slug)` helper. Safe to import anywhere; under
  `bun test` (SDK not started) every span is a no-op, so tests are unaffected.

## Custom spans

| Span | Where | PII-safe attributes |
|------|-------|---------------------|
| `credix.workflow` | `server.ts` /v1/chat | `app.workflow.status`, `app.active_skill` |
| `bureau.fetch` | `lib/bureau-fetch.ts` | `app.bureau.result` (ok/not_found/error/unreachable), `app.bureau.http_status` |
| `understand.classify` | `steps/understand.ts` | `app.intent`, `app.understand.error` |
| `agent.generate` | `workflows/credix-workflow.ts` | `app.active_skill`, `app.intent`, `app.tool_calls.count`, `app.response.empty` |

The incoming request span also carries `app.channel` and `app.session.provided`.

## PII rules (enforced)

By default, attributes NEVER carry the user mobile/`user_id`, raw user messages, PAN/Aadhaar, or
CIBIL scores; they hold only intents, skills, channels, counts, durations, and result
classifications. The opt-in `OTEL_CAPTURE_IO` mode (see `lib/otel.ts`) additionally records
scrubbed, truncated stage inputs/outputs for debugging; leave it off in production.

The bureau sidecar URL embeds the mobile (`/internal/bureau/<mobile>`). The auto undici span would
record that in `url.path`/`url.full`, so `tracing.ts` suppresses the auto span for those requests via
`instrumentation-undici.ignoreRequestHook`; the PII-safe `bureau.fetch` custom span covers the call.
For defence-in-depth in production, also run a Collector `redaction`/`attributes` processor.

## Run with tracing

The OTLP vars live in the repo-root `.env` (gitignored), which the `dev` script auto-loads via
`--env-file-if-exists=../../.env`:

```bash
# in .env (US region). Ingest key only — traces route by service.name (no dataset header needed).
OTEL_SERVICE_NAME=credix-mastra
OTEL_EXPORTER_OTLP_ENDPOINT=https://api.honeycomb.io
OTEL_EXPORTER_OTLP_HEADERS=x-honeycomb-team=YOUR_INGEST_KEY
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf

# then (tracing is on by default in the `dev` script):
pnpm dev   # = node --env-file-if-exists=../../.env --import tsx/esm --import ./tracing.ts server.ts
# use `pnpm dev:untraced` to run without the tracing SDK.
```

Honeycomb silently drops OTLP data without the `x-honeycomb-team` header. EU endpoint:
`https://api.eu1.honeycomb.io`.

## Verify locally first (no Honeycomb account)

A local OTel Collector confirms spans are produced and well-formed before pointing at Honeycomb.
Note: on a podman host, image short-names and bind-mounts need care — run the contrib collector with
a fully-qualified image and `--security-opt label=disable`, and read spans from `docker logs` (the
`debug` exporter) rather than a bind-mounted file:

```bash
docker run --name otel-collector --rm --security-opt label=disable \
  -p 4317:4317 -p 4318:4318 \
  -v "$PWD/otelcol.yaml:/etc/otelcol/config.yaml:ro" \
  docker.io/otel/opentelemetry-collector-contrib:latest --config /etc/otelcol/config.yaml &

# minimal otelcol.yaml: otlp receiver -> batch -> debug (verbosity: detailed) exporter
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 pnpm dev   # no auth header for local
# send a request, then: docker logs otel-collector | grep -E 'Name|app\.'
```

Verified locally: a `POST /v1/chat` produced one trace with `POST` (root) → `bureau.fetch` →
`tcp.connect`, `service.name=credix-mastra`, PII-safe `app.*` attributes, and **zero** occurrences
of the mobile in any span.

## Verifying data in Honeycomb (query-patterns)

The `query-patterns` skill verifies via the Honeycomb **MCP server**, which needs a **Management** API
key (`KeyID:Secret`, scopes: Model Context Protocol read + Environments read) and Honeycomb
Intelligence — distinct from the ingest key used above. Once connected:

- `get_workspace_context` → confirm the `credix-mastra` dataset exists
- `find_columns` → confirm `app.intent`, `app.bureau.result`, `app.active_skill` arrived
- `COUNT` grouped by `app.active_skill`; `P99(duration_ms)` filtered on `is_root` for user-facing latency
- never use `AVG` for latency; use `HEATMAP(duration_ms)` to spot bimodal distributions
