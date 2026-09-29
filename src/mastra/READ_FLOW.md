# Credix read flow — `/v1/chat` end to end (with Honeycomb spans)

Source-derived trace of ONE turn driven by the probe (`scripts/probe-turn.ts`), through the Hono
server, the single bureau fetch, the full `credixWorkflow`, and every emitted OpenTelemetry span.
Nothing here is decorative; every arrow and note maps to a line in source.

## Sequence

```mermaid
sequenceDiagram
    autonumber
    participant Probe as Probe<br/>(scripts/probe-turn.ts)
    participant Hono as Hono /v1/chat<br/>(server.ts)
    participant Sidecar as Bureau sidecar<br/>(Python: Redis L1/Mongo L2/Snowflake L3)
    participant WF as Workflow<br/>(credix-workflow.ts)
    participant Grok as xAI Grok<br/>(api.x.ai)
    participant Mem as Memory/OM<br/>(credixMemory, LibSQL)

    Note over Probe: reads probe.local.json {mobile, message, channel}<br/>opens root span probe.turn (traceId printed)
    Probe->>Hono: app.request POST /v1/chat {mobile, message, channel}

    Note over Hono: zValidator(chatSchema): mobile>=10, message>=1<br/>normalizeUserId(mobile) -> 10-digit user_id
    alt user_id invalid
        Hono-->>Probe: 400 {error: "Invalid mobile number"}
    end
    Note over Hono: session_id = body.session_id ?? crypto.randomUUID()

    rect rgb(255, 250, 230)
    Note over Hono,Sidecar: SPAN bureau.fetch (single fetch for whole request; closes review #3)
    Hono->>Sidecar: GET /internal/bureau/{user_id}<br/>header X-Internal-Token=INTERNAL_API_SECRET
    Note over Hono: undici auto-span suppressed for /internal/bureau/ (PII in path)<br/>tcp.connect span appears on first connection
    alt 200 OK
        Sidecar-->>Hono: strip_secure(doc): {general_info, loan_details, dpd, ...}<br/>secure sections (pii) dropped by the sidecar; app.bureau.result=ok
    else 404 no record
        Sidecar-->>Hono: 404  app.bureau.result=not_found
        Hono-->>Probe: 200 {active_skill:"not_found", response:"couldn't find a bureau record"}
    else non-2xx / transport error (sidecar down = status 0)
        Sidecar-->>Hono: 5xx / unreachable  app.bureau.result=error|unreachable
        Hono-->>Probe: 502 {error:"Bureau sidecar unavailable", detail:status}
    end
    end

    rect rgb(235, 245, 255)
    Note over Hono,WF: SPAN credix.workflow (wraps run.start; step spans nest under it)
    Hono->>WF: getWorkflow("credixWorkflow").createRun().start(<br/>{user_id, message, session_id, channel, bureau_profile})

    Note over WF: SPAN stage.decode
    alt inputData.audio_url present
        Note over WF: needs ELEVENLABS_API_KEY (STTError if missing)
        WF->>WF: withRetry(ElevenLabs speechToText scribe_v2) 3x, 500/1000ms backoff
        Note over WF: decoded_text=NFC(text); language from ISO-639-3 map
    else text message
        Note over WF: decoded_text=NFC(message); detectLanguage() by Unicode script (hi/gu/bn/ta/en)
    end

    Note over WF: SPAN stage.pre-guardrail
    alt INJECTION_PATTERNS match
        Note over WF: return pre_guardrail=false, reason="injection" (no LLM downstream)
    else UNSAFE_PATTERNS match
        Note over WF: return pre_guardrail=false, reason="unsafe"
    else clean
        Note over WF: maskProfilePii(getInitData().bureau_profile) deny-by-default<br/>-> masked_profile {user_id masked, general_info.credit_score, SAFE_SECTIONS, pii masked}
    end

    Note over WF: SPANS web.grounding ∥ understand.classify (concurrent)
    alt pre_guardrail == false
        Note over WF: short-circuit — NO LLM call, NO web search; intent stays undefined
    else GROK_API_KEY missing
        Note over WF: throw AppError 500 CONFIG_ERROR (only hard-fail path)
    else classify + ground in parallel
        Note over WF: SPAN web.grounding starts FIRST (needs only the message)<br/>Exa search, fail-soft '' on error/timeout/no key; skips greetings/short turns
        WF->>Grok: POST /v1/chat/completions (understandModel=grok-3)<br/>structuredOutput {intent} — intent-only, ~8 output tokens (latency fix)
        Note over WF: undici auto-span POST (+ tls.connect/tcp.connect on first call)
        alt LLM ok
            Grok-->>WF: {intent in [bureau_query|score_improvement|credit_card|insurance|general]}
        else transport/HTTP error
            Grok-->>WF: error
            Note over WF: degrade: intent="general", understand_error="llm_<status>"|"llm_unreachable"
        end
        Note over WF: join: web_context = intent==bureau_query ? '' : await grounding
    end

    Note over WF: .branch() runs EVERY truthy condition -> conditions are mutually exclusive
    alt !pre_guardrail
        Note over WF: guardrailRejectStep (NO LLM): polite injection/unsafe refusal
    else intent routes to one specialist (SPAN agent.generate)
        Note over WF: prompt = FULL masked_profile (JSON) + intent + statement hint + web_context (prefetched) + message + user_id<br/>(profile injected so the agent answers in ONE round-trip; latency fix)
        WF->>Grok: withRetry(agent.generate, grokModel, maxSteps:3, memory{resource:user_id,thread:session_id})
        opt agent still needs a detail not in the profile
            WF->>Sidecar: getBureauProfile/getBureauDetail tool -> GET /internal/bureau/{user_id}[/section]
            Sidecar-->>WF: PII-stripped profile/section (extra round-trip)
        end
        alt LLM ok
            Grok-->>WF: {raw_response, tool_calls_log[], active_skill}
        else LLM fails after retries
            Note over WF: fail-soft: safe fallback reply + agent_error="agent_generate_failed"
        end
    end

    Note over WF: Seam 1 .map(): firedBranch() collapse -> {raw_response, tool_calls_log, active_skill} (no span)

    Note over WF: SPAN stage.post-guardrail
    Note over WF: scrub Aadhaar(12) then PAN then mobile(10) -> [REDACTED]<br/>fresh RegExp each call (global lastIndex reset)

    Note over WF: SPAN stage.memory-writeback
    rect rgb(255, 250, 230)
    Note over WF,Mem: SPAN om.writeback (nested; fail-soft — never breaks the reply)
    WF->>Mem: engine.getStatus({threadId=session_id, resourceId=user_id})
    alt shouldObserve || canActivate || bufferedChunkCount>0
        WF->>Mem: engine.finalize() (may call Grok Observer)
    end
    alt post.shouldReflect
        WF->>Mem: engine.reflect() (may call Grok Reflector)
    end
    end

    Note over WF: Seam 2 .map(): rebuild compose input from getStepResult+getInitData<br/>degraded=Boolean(understand_error ?? agent_error); active_skill recovered (no span)

    Note over WF: SPAN stage.compose
    alt channel == tts
        WF->>Grok: withRetry(ElevenLabs textToSpeech eleven_flash_v2_5)
        alt audio ok
            Note over WF: composed = data:audio/mpeg;base64,...
        else TTS fails
            Note over WF: fail-soft: composed = spoken text, tts_failed=true (no 502)
        end
    else channel == whatsapp
        Note over WF: composed = markdown stripped, paras clipped to 3 lines
    else channel == web
        Note over WF: composed = response (passthrough)
    end
    WF-->>Hono: {composed, channel, active_skill, session_id, tts_failed, degraded, error_code}
    end

    alt workflow status != success
        Hono-->>Probe: 502 {error:"workflow failed", detail}
    else success
        Hono-->>Probe: 200 {response=composed, session_id, active_skill, tts_failed, degraded, error_code}
    end
    Note over Probe: prints status/latency/active_skill/response + traceId<br/>waits OTEL_BSP_SCHEDULE_DELAY+1.5s for span export, then exits
```

## Honeycomb span tree (one successful web turn)

`instrumentStage()` wraps most steps in `stage.<id>`; `understand` and the specialist own their
spans directly (`understand.classify`, `agent.generate`). All step spans nest under
`credix.workflow`, which nests under `bureau.fetch`'s sibling — both under the run's root
(`probe.turn` from the probe, or the auto `POST` http.server span in the live server).

```
probe.turn                                  (probe root; live server = auto "POST" span)
├── bureau.fetch                            app.bureau.result, app.bureau.http_status
│   └── tcp.connect                         (auto; first connection to sidecar only)
└── credix.workflow                      app.workflow.status, app.active_skill
    ├── stage.decode
    ├── stage.pre-guardrail
    ├── web.grounding                       app.web_grounding.used/.results — CONCURRENT with classify
    │   └── POST  (api.exa.ai)               auto undici; skipped on greetings/short turns/no key
    ├── understand.classify                 app.intent, app.understand.error (on degrade)
    │   └── POST  (api.x.ai)                 auto undici; + tls.connect/tcp.connect first call
    ├── agent.generate                      app.active_skill, app.intent, app.tool_calls.count
    │   └── POST  (api.x.ai)                 ONE round-trip after the fix; +N if a tool is called
    ├── stage.post-guardrail
    ├── stage.memory-writeback
    │   └── om.writeback                     app.om.pending_tokens, app.om.should_observe, app.om.observed
    └── stage.compose                        (+ ElevenLabs POST only when channel=tts)
```

Notes on what does NOT appear:
- The `/internal/bureau/` undici auto-span is intentionally suppressed (`tracing.ts`
  `ignoreRequestHook`) because the path embeds the mobile (PII); `bureau.fetch` is the PII-safe cover.
- Span attributes NEVER carry user_id/mobile/PAN/Aadhaar/credit score. Stage input/output capture
  (`app.io.*`) is OFF unless `OTEL_CAPTURE_IO=1`, and even then runs through `scrubIdentifiers`.
- The latency fix means `app.tool_calls.count` should be `0` on a plain profile question, and
  `agent.generate` shows a single `POST` child (no `getBureauProfile` re-fetch).

**Participants**
- Probe — `src/mastra/scripts/probe-turn.ts`; opens `probe.turn`, calls `app.request` in-process.
- Hono /v1/chat — `src/mastra/server.ts`; validation, `normalizeUserId`, single `fetchBureau`, workflow run, response mapping.
- Bureau sidecar — Python FastAPI `/internal/bureau/{user_id}`; resolver chain Redis L1 -> Mongo L2 -> Snowflake L3 (`src/nodes/raw_data/bureau/`).
- Workflow — `src/mastra/workflows/credix-workflow.ts`; the `.then/.branch/.map/.commit` chain and all steps under `src/mastra/steps/`.
- xAI Grok — `api.x.ai/v1/chat/completions` via `lib/provider.ts` (`understandModel=grok-3`, `grokModel=grok-4.3`); also the OM Observer/Reflector.
- Memory/OM — `src/mastra/memory/index.ts` `credixMemory` over LibSQL (`lib/storage.ts`); Observational Memory engine.

**Gaps & assumptions**
- ElevenLabs (STT in decode, TTS in compose) and Exa (web grounding) are shown as notes, not participant lifelines, to stay under 8 participants. For the probe's default `channel:"web"` text turn, STT is not hit, and Exa is skipped unless `EXA_API_KEY` is set (observed `[web-grounding] skipped` in test logs).
- The sidecar's internal L1/L2/L3 resolution and 15-day freshness window are collapsed into the single `Sidecar` lifeline; that path has its own diagram territory (`tasks/todo.md` Phase 6/8).
- The `getStatement` tool (statement-store) is omitted from the diagram; it only fires when a statement was previously uploaded via `POST /v1/statement`.
- Whether `understand.classify` at grok-3 lands at ~1-2s and whether `agent.generate` collapses to one round-trip is asserted from the code change, NOT yet confirmed on a live trace (needs the sidecar up + a real mobile with a record).
- `probe.turn` as root is probe-specific; in the live server the root is the auto `POST` http.server span (as seen in the earlier Honeycomb screenshot). The probe nests the workflow under `probe.turn` via an active-context span so the printed `traceId` is the whole tree.
- Retry policy (3 attempts, 500ms/1000ms, fast-fail 4xx except 429) is from `lib/retry.ts`; applied to STT, TTS, and specialist `agent.generate` only — not to `understand` or `bureau.fetch`.
```
