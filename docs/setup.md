# Local Setup Guide

A step-by-step guide to running the full Credit Credix stack on one machine: the Docker
container it needs, the local processes, the external cloud services, and every file path and
environment variable you have to wire up.

This guide is grounded in the [`Makefile`](../Makefile), [`docker-compose.yml`](../docker-compose.yml),
and the code. When a command here and the Makefile ever disagree, the Makefile wins.

---

## 1. What runs where

The system is one Docker container plus a few local processes talking to external cloud services.
Only Pogocache is containerized; everything else is either a local process you start or a hosted
service you point at with an environment variable.

| Component | Runs as | Port | How you start it |
|---|---|---|---|
| Pogocache (L1 cache) | **Docker container** (`cc-pogocache`) | 9401 | `make cache-up` |
| Python bureau sidecar (FastAPI) | local process | 8000 | `make dev-sidecar` |
| Mastra / Hono server | local process | 3000 | `make dev-mastra` |
| Next.js interface | local process | 5174 | `cd interface && npm run dev` |
| MongoDB (L2) | external service (Atlas) | n/a | `MONGODB_URI` env |
| Snowflake (L3) | external service | n/a | `SNOWFLAKE_*` env |
| Postgres card catalog | external service (Cred Supabase) | n/a | `DATABASE_URL` env |
| Grok / ElevenLabs / Exa | external APIs | n/a | API-key envs |

The data flow at runtime: the interface calls the Hono server, the Hono server calls the Python
sidecar over `/internal/*`, and the sidecar reads Pogocache, then MongoDB, then Snowflake.

**The only required container is Pogocache.** MongoDB, Snowflake, and the card catalog are hosted
services in this setup, not local containers. There is a `docker-compose.override.yml` reserved for
adding local Mongo or Postgres later, but it is currently empty.

---

## 2. Prerequisites

Install these and confirm each is on your PATH:

| Tool | Minimum | Check | Notes |
|---|---|---|---|
| Docker or Podman | any recent | `docker --version` | Podman works; pass `make DOCKER=podman <target>` |
| `redis-cli` | 6+ | `redis-cli --version` | from `redis-tools`; used to health-check Pogocache over RESP2 |
| `uv` | 0.4+ | `uv --version` | runs and installs the Python sidecar |
| `bun` | 1.3+ | `bun --version` | runs and tests the Mastra layer |
| Node.js + npm | 20+ | `node --version` | runs the interface |
| Python | 3.11+ | `python3 --version` | interpreter for the sidecar (`pyproject` requires 3.11) |

You also need credentials for the external services (Section 5): a MongoDB Atlas URI, Snowflake
account plus a key file, an xAI Grok key, and (optionally) ElevenLabs, Exa, and the catalog Postgres
URL.

---

## 3. Step 1: clone and install Python dependencies

```bash
git clone <repo-url> Credix
cd Credix

# Install the sidecar dependencies (dev + graph extras; the graph extra provides FastAPI + uvicorn)
uv sync --extra dev --extra graph
# Alternative, using the Makefile (plain pip into the active environment):
#   make install        # pip install -e ".[dev,graph]"
```

Why the extras matter: FastAPI and uvicorn live under the `graph` optional-dependency group in
[`pyproject.toml`](../pyproject.toml), so a plain install without `--extra graph` leaves the sidecar
unable to start.

**Path note:** the sidecar is launched as `uv run uvicorn src.nodes.api.app:app` from the repository
root ([`Makefile`](../Makefile) `dev-sidecar` target). Running from the root is what puts `config/`
and `src/nodes/` on the import path, so `from config.settings import load_env` inside
[`app.py`](../src/nodes/api/app.py) resolves. Do not run the sidecar from inside `src/`.

---

## 4. Step 2: start the Pogocache container

Pogocache is the L1 cache. It is a plain RESP key/value store (not RedisJSON), disposable and
in-memory: MongoDB (L2) is the durable source of truth, so if the cache is evicted or lost it simply
refills on the next read.

### The easy path

```bash
make cache-up        # idempotent: does nothing if :9401 already answers PING
make cache-ping      # expect: PONG
```

`make cache-up` ([`Makefile`](../Makefile) lines 40 to 49) runs, in order:

1. If `redis-cli -p 9401 -2 PING` already succeeds, it does nothing.
2. Else if a stopped `cc-pogocache` container exists, it starts it.
3. Else it creates one:

   ```bash
   docker run -d --name cc-pogocache --network host --restart unless-stopped \
     docker.io/pogocache/pogocache:latest --maxmemory 75% --evict yes
   ```

### Using docker compose instead

The same container is described in [`docker-compose.yml`](../docker-compose.yml):

```bash
docker compose up -d pogocache      # or: podman compose up -d pogocache
```

The Makefile deliberately uses `docker run` rather than compose because Podman Compose has a
version mismatch on some machines; either method produces the same `cc-pogocache` container.

### macOS or Windows

`--network host` (and `network_mode: host` in the compose file) works on **Linux and Podman only**.
On Docker Desktop for macOS or Windows, host networking is not supported. Edit
[`docker-compose.yml`](../docker-compose.yml): comment out the `network_mode: host` line and
uncomment the `ports: ["127.0.0.1:9401:9401"]` mapping, then `docker compose up -d pogocache`.

### Podman

```bash
make DOCKER=podman cache-up
```

### Lifecycle

```bash
make cache-logs      # follow container logs
make cache-cli       # interactive RESP2 shell (redis-cli -p 9401 -2)
make cache-down      # stop and remove the container
```

### Verify

```bash
redis-cli -p 9401 -2 PING     # PONG
```

The `-2` flag forces RESP2. This matters: Pogocache rejects the RESP3 `HELLO` handshake that newer
clients send by default, which is why the application code sets `protocol=2` and `redis-cli` needs
`-2`. See Troubleshooting if `PING` hangs or errors.

---

## 5. Step 3: environment files and their paths

There are **two** environment files, at two different paths, and it is important to get them right
because each layer loads a different one.

### 5.1 The repository-root `.env` (Python sidecar AND Mastra server)

Both back-end layers read the **same** file at the repository root:

- The Python sidecar loads it via `load_env()` in [`config/settings.py`](../config/settings.py),
  called at app startup ([`app.py`](../src/nodes/api/app.py)). `uv run uvicorn` does not auto-load
  `.env`, so this explicit load is what populates the connection variables.
- The Mastra server loads it via `--env-file-if-exists=../../.env` in its `dev` script
  ([`src/mastra/package.json`](../src/mastra/package.json)). That script runs from `src/mastra/`, so
  `../../.env` resolves to the repository root, the same file.

Create it from the example and fill it in:

```bash
cp .env.example .env
```

Required for a working turn:

| Variable | Layer | Purpose |
|---|---|---|
| `INTERNAL_API_SECRET` | both | Shared secret for the `/internal/*` routes; the sidecar fatal-rejects with 403 if it is empty, and the Mastra server refuses to boot if it is unset |
| `MONGODB_URI` | Python | L2 store (Atlas connection string) |
| `SNOWFLAKE_ACCOUNT`, `_USER`, `_ROLE`, `_WAREHOUSE`, `_DATABASE`, `_SCHEMA` | Python | L3 connection |
| `SNOWFLAKE_PRIVATE_KEY_FILE` (or `_PAT` / `_PASSWORD`) | Python | L3 auth; see Section 6.1 |
| `GROK_API_KEY` | Mastra | The LLM; the server warns and generation fails without it |
| `BUREAU_SIDECAR_URL` | Mastra | Sidecar base URL; default `http://localhost:8000` |

Common optional variables: `MONGODB_DB` (default `consumer`), `REDIS_URL` (default
`redis://localhost:9401`), `BUREAU_FRESH_DAYS` (default 15), `ELEVENLABS_API_KEY` (voice),
`EXA_API_KEY` (web grounding), `DATABASE_URL` (card catalog), and the `OTEL_*` group (tracing). The
full list with defaults is in the [README Configuration section](../README.md#configuration) and
[`.env.example`](../.env.example).

`INTERNAL_API_SECRET` must be **identical** in the sidecar and Mastra halves, because they are the
same file, so setting it once is enough.

### 5.2 The interface `.env.local` (Next.js)

The interface does **not** read the repository-root `.env`. It reads its own file at
`interface/.env.local`:

```bash
cp interface/.env.example interface/.env.local
```

| Variable | Purpose |
|---|---|
| `CREDIX_API_URL` | The Hono server URL the interface proxies to; default `http://localhost:3000` |
| `ELEVENLABS_API_KEY` | Voice STT and TTS proxying (optional) |
| `ELEVENLABS_STT_MODEL`, `ELEVENLABS_VOICE_ID`, `ELEVENLABS_TTS_MODEL` | Voice model overrides (optional) |
| `DATALAB_API_KEY` | Better PDF statement parsing; falls back to local parsing if unset (optional) |

---

## 6. Step 4: external service paths and file-path variables

### 6.1 Snowflake key file (a real path dependency)

Snowflake auth ([`snowflake_client.py`](../src/nodes/raw_data/bureau/snowflake_client.py)) tries, in
order: PAT, password, then a key-pair (JWT) private key file. The example env uses the key file:

- Put the private key `.p8` file somewhere outside the repo, for example `~/.snowflake/bureau.p8`.
- Set `SNOWFLAKE_PRIVATE_KEY_FILE` to its **absolute path**.
- If the key is encrypted, also set `SNOWFLAKE_PRIVATE_KEY_PWD`.

Alternatively, set `SNOWFLAKE_CONNECTION_NAME` (default `bureau_jwt`) and define that connection in
`~/.snowflake/connections.toml`; the client falls back to it when the explicit variables are absent.

### 6.2 MongoDB Atlas

Set `MONGODB_URI` to your Atlas connection string and `MONGODB_DB` (default `consumer`). There is no
local Mongo container; the L2 store is expected to be Atlas.

### 6.3 Postgres card catalog (optional)

The credit-card catalog tools read a Postgres database through `DATABASE_URL`. This is optional: when
`DATABASE_URL` is unset the catalog tools fail soft (they return a "catalog unavailable" message and
the rest of the app runs normally), so you can skip it unless you are working on the card tools. TLS
is on by default; use `DB_SSL_CA` and `DB_SSL_VERIFY` to control certificate verification.

### 6.4 File paths created at runtime (no action needed, but good to know)

- `MASTRA_DB_URL` (default `file:./mastra.db`) is a LibSQL file created on first run, relative to
  `src/mastra/`.
- `STATEMENT_STORE_DIR` (default a `.statement-store` folder next to the Mastra package) holds
  uploaded, chunked statements.
- [`config/scrub_mapping.yaml`](../config/scrub_mapping.yaml) is resolved relative to the bureau
  module and ships in the repo; it must exist for the normalizer and signal engine to run.

---

## 7. Step 5: bring up the stack

With the container running (Section 4) and both env files in place (Section 5):

```bash
# From the repository root: starts Pogocache (if needed) + sidecar (:8000) + Mastra (:3000)
make dev
```

`make dev` runs `cache-up` then launches the sidecar and the Mastra server together. Start the
interface in a second terminal:

```bash
cd interface
npm install         # first time only
npm run dev         # http://localhost:5174
```

Or start each back-end process on its own:

```bash
make cache-up
make dev-sidecar    # terminal 1
make dev-mastra     # terminal 2
```

### Verify each layer

```bash
# 1. Cache
redis-cli -p 9401 -2 PING                       # PONG

# 2. Sidecar (needs the shared secret; there is no public health route)
curl -s -H "X-Internal-Token: $INTERNAL_API_SECRET" \
  http://localhost:8000/internal/bureau/9944003361 | head -c 200

# 3. Mastra server
curl -s http://localhost:3000/health            # {"ok":true}

# 4. A full turn
curl -s -X POST http://localhost:3000/v1/chat \
  -H 'content-type: application/json' \
  -d '{"mobile":"9944003361","message":"how is my credit score?","channel":"web"}'

# 5. Interface: open http://localhost:5174
```

For step 4, use a mobile that has a bureau record; an unknown mobile returns a friendly
"not found" reply rather than an error.

---

## 8. Teardown

```bash
# Stop the app processes with Ctrl-C in their terminals, then:
make cache-down       # stop and remove the Pogocache container
# or:
make stack-down       # alias that tears the cache down
```

The cache is disposable, so removing it loses nothing durable; it refills from MongoDB on the next
read.

---

## 9. Optional: a local OpenTelemetry collector

To verify tracing locally without a Honeycomb account, run the contrib collector in a container and
point the Mastra server at it. Full instructions, including the Podman-specific flags and the
minimal `otelcol.yaml`, are in [`src/mastra/OBSERVABILITY.md`](../src/mastra/OBSERVABILITY.md). In
short:

```bash
docker run --name otel-collector --rm --security-opt label=disable \
  -p 4317:4317 -p 4318:4318 \
  -v "$PWD/otelcol.yaml:/etc/otelcol/config.yaml:ro" \
  docker.io/otel/opentelemetry-collector-contrib:latest --config /etc/otelcol/config.yaml &

OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 pnpm dev   # from src/mastra, no auth header for local
```

If neither `OTEL_EXPORTER_OTLP_ENDPOINT` nor `OTEL_EXPORTER_OTLP_HEADERS` is set, tracing is simply
disabled and the server runs normally.

---

## 10. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `redis-cli PING` hangs or errors, or the app logs a RESP3/`HELLO` error | The client spoke RESP3. Pogocache is RESP2-only. Use `redis-cli -p 9401 -2`; application code already sets `protocol=2`. |
| Mastra server exits immediately with a port message | `PORT` must not be 2024 (that is the Mastra Studio port); the server fatal-exits on it. Use 3000 or another free port. |
| Mastra server refuses to boot | `INTERNAL_API_SECRET` is unset in the repository-root `.env`. |
| Sidecar returns 403 on every `/internal/*` call | The `X-Internal-Token` header does not match `INTERNAL_API_SECRET`, or the sidecar did not load `.env`. Confirm the secret is set in the repository-root `.env` and that you launched from the root. |
| `network_mode: host` error on macOS or Windows | Host networking is Linux/Podman only. Use the `ports` mapping in `docker-compose.yml` (Section 4). |
| `docker` actually runs Podman, or vice versa | Override with `make DOCKER=podman <target>` (or `make DOCKER=docker <target>`). |
| `ModuleNotFoundError` for `config` or `nodes` when starting the sidecar | Start from the repository root (`make dev-sidecar`), and confirm dependencies were installed with the `graph` extra (Section 3). |
| Catalog tools return "unavailable" | `DATABASE_URL` is unset. This is expected and non-fatal unless you are working on the card tools (Section 6.3). |
| Voice or web grounding does nothing | `ELEVENLABS_API_KEY` / `EXA_API_KEY` are optional and unset; both features fail soft. |
