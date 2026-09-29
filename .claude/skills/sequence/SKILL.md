---
name: sequence
description: Create a Mermaid sequence diagram from a complete workflow the user describes (or that you trace through code). Use when the user wants a sequence diagram, asks to diagram a flow/request path/event pipeline, or invokes /sequence. Produces a source-derived diagram with named participants, real method/payload labels, every branch and retry, security Note blocks, and a mandatory Gaps & assumptions section. Follow the anti-patterns below exactly.
---

# Sequence

Turn a complete workflow into a **diagnostic** Mermaid `sequenceDiagram` — one a reviewer can verify line-by-line against source, not a decorative picture.

## Process

1. **Get the full workflow.** If the user gave a complete description, use it. If they pointed at code, trace it: entry point → every call, branch, retry, and external system → return. Don't diagram what you haven't traced.
2. **Pick one question per diagram.** If the flow spans more than ~8 participants, split it into multiple diagrams and link them via `Note over` references.
3. **Draw it** in a Mermaid `sequenceDiagram` block, obeying every anti-pattern rule below.
4. **Append the required sections**: `**Participants**` (list, each naming its file/module/system) and `**Gaps & assumptions**` (specific, mandatory).

## Palette & syntax conventions

- Sync call: `->>`. Async dispatch (queue publish, fire-and-forget): `-)`. The queue/bus is its own participant lifeline, never an arrow.
- Branches: `alt`/`else`. Retries/polling: `loop`. Invariants & security steps: `Note over` (renders light yellow).
- Colors come from structure (`alt`/`loop`/`Note`), never custom CSS. Palette is fixed: light blue / white / light yellow only.
- No emojis or decorative glyphs anywhere (participants, labels, notes). Convey status/meaning with plain text tags like `[done]`, `[pending]`, `[auth]`, or `IMPLEMENTED 002` / `PENDING 004.2`. See anti-pattern 11.

---

# Anti-Patterns

Common mistakes that turn a diagnostic diagram into a decorative one. Each has a fix.

---

## 1. Vague participant names

A participant called `Service` or `Backend` tells the reader nothing and lets bugs hide behind ambiguity.

**Bad**
```
participant API as API
participant DB as Database
```

**Good**
```
participant API as FastAPI<br/>(routes/triage.py)
participant DB as Postgres<br/>(reports table)
```

Rule: every participant alias names the file, module, or external system. A reader should be able to grep for it.

---

## 2. Vague arrow labels

"Calls the service" is not a label. The reader cannot verify it against source.

**Bad**
```
API->>Worker: sends job
Worker-->>API: response
```

**Good**
```
API-)Queue: publish(IssueTriageJob{repo, num})
Worker->>Queue: consume()
Queue-->>Worker: IssueTriageJob{repo, num}
```

Rule: every arrow names a real method, endpoint, event, or message. Payload shape on returns.

---

## 3. Missing error / branch paths

If the code has an `if` or a `try/except`, the diagram must show it. A diagram that only shows the happy path is misinformation.

**Bad** (code has retry but diagram doesn't)
```
W->>GH: POST /labels
GH-->>W: 200
```

**Good**
```
loop attempt = 1..3 until 2xx
    W->>GH: POST /labels
    alt 2xx
        GH-->>W: 200 OK
    else 429 rate-limited
        GH-->>W: 429 {retry_after}
        Note over W: sleep(retry_after); continue
    else 5xx
        GH-->>W: 5xx
        Note over W: backoff and retry
    end
end
```

Rule: every conditional in code is an `alt` in the diagram. Every retry is a `loop`.

---

## 4. Decorative color

Coloring the "bad path" red defeats the strict palette and is redundant with `alt`/`else`.

**Bad**
- Custom red box around the error branch
- Different participant colors to "make it pop"

**Good**
- Use `alt`/`else` for branching
- Use `Note over` (light yellow) to flag invariants and gotchas
- Keep the palette: light blue / white / light yellow only

Rule: meaning comes from structure, not color. The palette is fixed.

---

## 5. Async drawn as sync

A queue publish and a function call are not the same. Drawing both with `->>` hides the most important property of the system.

**Bad**
```
API->>Worker: trigger job
```

**Good**
```
API-)Queue: publish(Job)
Worker->>Queue: consume()
```

Rule: async dispatch uses `-)`. Sync calls use `->>`. The queue is a participant on its own lifeline, not an arrow.

---

## 6. Too many participants

Past ~8 participants, a sequence diagram becomes a wiring diagram. The reader loses the thread.

**Bad**
- One diagram with: User, SPA, CDN, API Gateway, Auth Service, Rate Limiter, Main API, Cache, Primary DB, Replica DB, Event Bus, Worker A, Worker B, Email Service, SMS Service, …

**Good**
- One diagram for "request hits the edge and reaches Main API"
- A second for "Main API does its work and publishes events"
- A third for "Workers consume events and notify users"
- Link them by referencing entry/exit points in `Note over` blocks: `Note over API: see "request-edge" diagram for upstream`

Rule: max 8 participants per diagram. One question per diagram.

---

## 7. Unlabeled returns

A return arrow with no label is a missed opportunity to show what shape the caller is now holding.

**Bad**
```
DB-->>API: 
```

**Good**
```
DB-->>API: {report_id, status="done", payload}
```

Rule: every `-->>` has a payload shape or status code.

---

## 8. Missing `Note over` for security-critical steps

Signature verification, idempotency, rate-limit checks, and authorization decisions are exactly where bugs live and exactly what reviewers need to see.

**Bad** (signature verification happens in code but is invisible in the diagram)
```
GH_User->>API: POST /webhook
API->>Q: publish(Job)
```

**Good**
```
GH_User->>API: POST /webhook (X-Hub-Signature-256)
Note over API: verify_signature(secret) — constant-time compare<br/>401 on mismatch
API-)Q: publish(Job)
```

Rule: every auth check, signature verification, idempotency key check, rate-limit gate, and short-circuit error gets a `Note over` block.

---

## 9. Skipping the "Gaps & assumptions" section

A diagram without a gaps section pretends to be complete. It will not be. The gaps section is where the reviewer's eyes go first.

**Bad**
```
[diagram]
```

**Good**
```
[diagram]

**Participants**
- ...

**Gaps & assumptions**
- Logging and metrics emission omitted from diagram
- Retry policy inferred from `RETRY_MAX=3` env var; not verified against code
- Diagram assumes Redis Streams; if codebase uses RQ, the consume arrows are wrong
- Dead-letter handling after MaxReceiveCount not shown
```

Rule: the gaps section is mandatory and specific. "Some things were simplified" is not acceptable — name them.

---

## 10. Diagram drifts from code

A diagram committed in `/docs` and never updated lies more loudly than no diagram at all.

**Fix:**
- Commit the `.md` next to the code it describes
- In PR review, ask "does this PR change behavior shown in `flow.md`? If yes, update the diagram."
- Periodically regenerate the diagram from current source and diff. Anywhere the regenerated diagram differs from the committed one is either drift in the code or stale documentation — both worth investigating.

Rule: a sequence diagram is source-derived. If source changes, the diagram changes.

---

## 11. Emojis and decorative glyphs

Emojis (✅, 🚧, 🔴, ⚠️, 🔒, ▶️, etc.) are decorative noise. They render inconsistently across Mermaid themes and terminals, are not greppable, and smuggle meaning into a glyph a reviewer has to decode. Status, security, and branch meaning must be plain, searchable text.

**Bad**
```
participant WF as Workflow ✅ (workflow.ts)
API->>WF: 🚀 start(job)
Note over API: 🔒 verify signature
Note over WF: 🚧 pending — not built yet
```

**Good**
```
participant WF as Workflow<br/>(workflow.ts) [done]
API->>WF: start(job)
Note over API: verify_signature(secret) — auth, 401 on mismatch
Note over WF: PENDING — not built yet (issue 004.2)
```

Rule: no emojis anywhere — participants, arrows, or notes. Use text tags (`[done]`, `[pending]`, `[auth]`, `IMPLEMENTED 002`, `PENDING 004.2`) and let `alt`/`loop`/`Note over` carry structural meaning.
