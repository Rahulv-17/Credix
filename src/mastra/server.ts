// FIRST import on purpose: installs the keep-alive fetch dispatcher before any module can make an
// outbound call. Lives here (not tracing.ts) so dev:untraced and the probe get it too.
import './lib/http-dispatcher'
import { Hono } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { serve } from '@hono/node-server'
import { bodyLimit } from 'hono/body-limit'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { fileURLToPath } from 'node:url'
import { trace } from '@opentelemetry/api'
import { AppError } from './lib/errors'
import { tracer } from './lib/otel'
import { RequestContext, MASTRA_RESOURCE_ID_KEY } from '@mastra/core/request-context'
import { detectLanguage, nextLangState } from './lib/language'
import { sessionLanguage } from './lib/session-state'
import { normalizeUserId } from './lib/normalize-user-id'
import { fetchBureau } from './lib/bureau-fetch'
import { fetchUserStory } from './lib/user-story-fetch'
import { putStatement } from './lib/statement-store'
import { mastra, observability } from './index'

const PORT = Number(process.env.PORT ?? 3000)
const MASTRA_STUDIO_PORT = 2024

// True only when this file is the process entry (node/bun running server.ts directly). Under
// `bun test`, argv[1] is the test runner, so the entry side-effects below are skipped and e2e.test.ts
// can import `app` without binding a port or tripping the process.exit guards.
const isEntry = process.argv[1] === fileURLToPath(import.meta.url)

export const app = new Hono()

// Global error handler: typed AppErrors serialize to { success, error: { message, code } }.
// Unknown errors expose the stack ONLY in development; everywhere else (production, staging,
// test, or NODE_ENV unset) return a generic 500 so internal details / PII never leak.
app.onError((err, c) => {
  if (err instanceof AppError) {
    return c.json(err.toHttpResponse(), err.statusCode as ContentfulStatusCode)
  }
  console.error('[server] Unhandled error:', err)
  if (process.env.NODE_ENV === 'development') {
    return c.json({ success: false, error: { message: err.message, stack: (err as any).stack } }, 500)
  }
  return c.json({ success: false, error: { message: 'Internal server error', code: 'INTERNAL_ERROR' } }, 500)
})

const chatSchema = z.object({
  mobile: z.string().min(10),
  message: z.string().min(1),
  session_id: z.string().optional(),
  channel: z.enum(['web', 'whatsapp', 'tts']).default('web'),
})

// Ingest a parsed, chunked statement document (from the interface PDF parser). Stored per user so
// the getStatement tool can serve it to the specialist agents on later turns.
// Conservative upper bounds so a single upload can't cause memory/disk pressure (the payload is
// written to disk by putStatement). A real statement is well within these; anything larger is
// rejected at validation time (400) rather than persisted.
//
// The AGGREGATE cap is what actually bounds the write: per-field maxima alone let 2,000 chunks of
// 100,000 chars pass validation (~200 MB) while meta.chars claims far less, then putStatement
// serializes and writes that synchronously, blocking the event loop and exhausting disk (Sudhanshu
// PR #14 review, P1). The superRefine below binds the real payload (sum of chunk text) to both the
// hard cap and the declared meta.chars, and bodyLimit on the route rejects an oversized body before
// it is even buffered/parsed.
const STATEMENT_CHARS_CAP = 5_000_000 // matches meta.chars max; the true ceiling on stored text
// Transport-layer body cap, DERIVED from the char cap (3 bytes/char) so the two can't drift into the
// inconsistency where a schema-valid payload is rejected with 413 before it is even parsed. Real
// statements measure ~1.13 bytes/char (mostly ASCII; JSON ids/headings/keys/escaping add ~13%), so
// 3 bytes/char keeps ~2.6x headroom over the worst realistic upload and still covers occasional
// 3-byte BMP glyphs (rupee sign, Devanagari names). We deliberately do NOT budget for 4-byte
// codepoints: a 5M-char payload of those is ~20 MiB, which is the abuse case this limit exists to
// reject at the transport layer before buffering.
const STATEMENT_BODY_LIMIT_BYTES = STATEMENT_CHARS_CAP * 3 // 15 MB

export const statementSchema = z.object({
  mobile: z.string().min(10).max(20),
  session_id: z.string().max(200).optional(),
  document: z
    .object({
      meta: z.object({
        source: z.string().max(500),
        pages: z.number().int().nonnegative().max(10_000).nullable(),
        chars: z.number().int().nonnegative().max(STATEMENT_CHARS_CAP),
        uploadedAt: z.string().max(64),
      }),
      chunks: z
        .array(
          z.object({
            id: z.string().max(200),
            index: z.number().int().nonnegative().max(10_000),
            heading: z.string().max(1_000),
            text: z.string().max(100_000),
            chars: z.number().int().nonnegative().max(100_000),
          }),
        )
        .min(1)
        .max(2_000),
    })
    .superRefine((doc, ctx) => {
      const totalText = doc.chunks.reduce((n, ch) => n + ch.text.length, 0)
      // Hard ceiling on the actual stored payload, independent of what meta claims.
      if (totalText > STATEMENT_CHARS_CAP) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['chunks'],
          message: `Total statement text (${totalText} chars) exceeds the ${STATEMENT_CHARS_CAP} character cap.`,
        })
      }
      // meta.chars must not understate the real payload, so a small declared size can't smuggle a huge
      // body past the per-field maxima. Allow meta.chars >= actual (headings/whitespace not counted).
      if (totalText > doc.meta.chars) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['meta', 'chars'],
          message: `Declared meta.chars (${doc.meta.chars}) is less than the actual chunk text (${totalText} chars).`,
        })
      }
    }),
})

app.post('/v1/chat', zValidator('json', chatSchema), async (c) => {
  const body = c.req.valid('json')
  const user_id = normalizeUserId(body.mobile)
  if (!user_id) {
    return c.json({ error: 'Invalid mobile number — must resolve to 10 digits' }, 400)
  }
  const session_id = body.session_id ?? crypto.randomUUID()

  // PII-safe attributes on the auto-instrumented HTTP server span. Never the mobile or message.
  const httpSpan = trace.getActiveSpan()
  httpSpan?.setAttribute('app.channel', body.channel)
  httpSpan?.setAttribute('app.session.provided', Boolean(body.session_id))

  // Single bureau fetch for the whole request — the profile is passed into the workflow so
  // preGuardrailStep masks it instead of re-fetching (closes review #3).
  const bureau = await fetchBureau(user_id)
  if (!bureau.ok) {
    if ('notFound' in bureau) {
      return c.json({
        response: "We couldn't find a bureau record for this number. Please try with your registered bank mobile number.",
        session_id,
        active_skill: 'not_found',
      })
    }
    return c.json({ error: 'Bureau sidecar unavailable', detail: bureau.status }, 502)
  }

  // Precomputed persona signals ride alongside the profile (same single-fetch posture, own
  // in-process cache + `user-story.fetch` span). Enrichment only: a miss/error is non-fatal, so
  // the specialist still runs on the masked profile. The payload carries derived signals (incl.
  // exact age per the approved relaxation) and reaches the agent via initData, never a span/log.
  const story = await fetchUserStory(user_id)
  const signals = story.ok ? story.signals : undefined

  // Central per-request context. The master agent and, via delegation, the workers and their tools
  // read user_id from here (context-first, arg fallback) instead of relying on the LLM to echo it
  // back from prompt text. MASTRA_RESOURCE_ID_KEY pins memory ownership to this user.
  const requestContext = new RequestContext()
  requestContext.set('user_id', user_id)
  requestContext.set(MASTRA_RESOURCE_ID_KEY, user_id)
  requestContext.set('channel', body.channel)

  // Language, detected per turn and committed per session with a 2-vote debounce (lib/language).
  // Every agent's instructions are function-valued and read this key, so the master AND the workers it
  // delegates to answer in the user's register. Detection is a pure function, no model call.
  // Note: the message here is the RAW body text. For a voice turn the transcript only exists after
  // decodeStep, so an audio-first Hinglish turn commits its language one turn late; text turns (web,
  // whatsapp) are immediate. Recorded as a known limit rather than moving detection into the workflow,
  // which would put it after preGuardrailStep and lose the raw text anyway.
  const detected = detectLanguage(body.message)
  // Keyed by user AND session. session_id is client-supplied, so two mobiles can present the same one,
  // and on a bare session_id the second user would read the first user's committed language: after a
  // Hindi session, their first English turn still answers in Hindi, because the debounce needs a second
  // opposing vote to switch. Workflow memory already scopes the same thread id by user_id as its
  // resource, so this matches it (PR #20 review).
  const langKey = `${user_id}:${session_id}`
  const langState = nextLangState(sessionLanguage.get(langKey), detected)
  // Re-set every turn, which is also what keeps an active session from being evicted (session-state).
  sessionLanguage.set(langKey, langState)
  requestContext.set('language', langState.committed)
  httpSpan?.setAttribute('app.language.detected', detected)
  httpSpan?.setAttribute('app.language.committed', langState.committed)

  // getWorkflow keys by the REGISTRATION KEY ('credixWorkflow'), not the workflow id.
  const run = await mastra.getWorkflow('credixWorkflow').createRun()
  // Custom span over the whole workflow run; the step spans (understand.classify, agent.generate,
  // bureau.fetch) nest under this. Attributes are the routing outcome only — no message/PII.
  const result = await tracer.startActiveSpan('credix.workflow', async (span) => {
    try {
      const r = await run.start({
        inputData: {
          user_id,
          message: body.message,
          session_id,
          channel: body.channel,
          bureau_profile: bureau.profile,
          signals,
        },
        requestContext,
        // Trace-level metadata for the Langfuse view. The exporter maps `sessionId` -> Langfuse
        // session (so every turn of one conversation groups into one session), `userId` -> Langfuse
        // user, and `traceName` -> trace name. traceName is NOT optional in practice: with the agent
        // spans nested under this run, the exporter's own root-span naming produced empty trace names
        // (verified live), so the list view was a wall of blank rows. userId is the raw mobile by
        // explicit decision; lib/langfuse-observability.ts exempts that one field from the identifier
        // scrub and redacts it everywhere else. `channel` stays on the root span's metadata.
        tracingOptions: {
          metadata: {
            traceName: 'credix-turn',
            sessionId: session_id,
            userId: user_id,
            channel: body.channel,
          },
        },
      })
      span.setAttribute('app.workflow.status', r.status)
      if (r.status === 'success') {
        span.setAttribute('app.active_skill', r.result.active_skill)
        httpSpan?.setAttribute('app.active_skill', r.result.active_skill)
      }
      return r
    } finally {
      span.end()
    }
  })

  if (result.status !== 'success') {
    const detail = result.status === 'failed' ? result.error?.message : result.status
    return c.json({ error: 'workflow failed', detail }, 502)
  }

  return c.json({
    response: result.result.composed,
    session_id,
    active_skill: result.result.active_skill,
    tts_failed: result.result.tts_failed ?? false,
    // A real backend degradation (LLM outage in understand or a specialist) surfaced behind a safe
    // 200 fallback reply, so the client can flag it and alerting isn't blind to it.
    degraded: result.result.degraded ?? false,
    error_code: result.result.error_code,
  })
})

app.post(
  '/v1/statement',
  // Earliest guard: reject an oversized body at the transport layer, before it is buffered or parsed
  // (the per-field zod maxima alone would let ~200 MB through to putStatement).
  bodyLimit({
    maxSize: STATEMENT_BODY_LIMIT_BYTES,
    onError: (c) => c.json({ error: 'Statement payload too large' }, 413),
  }),
  zValidator('json', statementSchema),
  async (c) => {
  const body = c.req.valid('json')
  const user_id = normalizeUserId(body.mobile)
  if (!user_id) {
    return c.json({ error: 'Invalid mobile number — must resolve to 10 digits' }, 400)
  }
  putStatement(user_id, body.document)
  const httpSpan = trace.getActiveSpan()
  httpSpan?.setAttribute('app.statement.chunks', body.document.chunks.length)
  return c.json({ ok: true, chunks: body.document.chunks.length })
})

app.get('/health', (c) => c.json({ ok: true }))

// ── Entry-only side effects ─────────────────────────────────────────────────────
// Env guards, the HTTP listener, and process handlers run ONLY when server.ts is the entry.
if (isEntry) {
  if (!process.env.INTERNAL_API_SECRET) {
    console.error('FATAL: INTERNAL_API_SECRET is not set')
    process.exit(1)
  }
  // Provider comes from MASTER_MODEL / WORKER_MODEL, so accept either provider's key here.
  if (!process.env.XAI_API_KEY && !process.env.GEMINI_API_KEY && !process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
    console.warn('[server] no LLM key set (XAI_API_KEY for grok, GEMINI_API_KEY for google); LLM calls will fail at runtime')
  }
  if (PORT === MASTRA_STUDIO_PORT) {
    console.error(`FATAL: PORT=${PORT} conflicts with Mastra Studio port. Use a different PORT.`)
    process.exit(1)
  }

  const server = serve({ fetch: app.fetch, port: PORT })
  console.log(`[server] Hono listening on :${PORT}  (Mastra Studio: pnpm mastra:dev on :${MASTRA_STUDIO_PORT})`)

  process.on('uncaughtException', (err) => {
    console.error('[server] Uncaught exception — shutting down:', err)
    process.exit(1)
  })

  process.on('unhandledRejection', (reason) => {
    console.error('[server] Unhandled promise rejection:', reason)
  })

  // SIGINT as well as SIGTERM: a turn's ROOT span ends last, so an unflushed exit loses exactly the
  // trace-level record (name, input, output, workflow metadata) while the child spans survive, which
  // reads in Langfuse as an unnamed trace with no conversation on it. Ctrl+C in dev hits SIGINT.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      console.log(`[server] ${signal} received — shutting down gracefully`)
      server.close(async () => {
        console.log('[server] HTTP server closed')
        // Flush buffered Langfuse spans before exit (no-op when observability is unconfigured), so the
        // last batch of AI traces is not lost on deploy/restart.
        try {
          const instances = observability?.listInstances()
          if (instances) for (const inst of instances.values()) await inst.flush()
        } catch (err) {
          console.warn('[server] observability flush error', err)
        }
        process.exit(0)
      })
    })
  }
}
