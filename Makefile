.PHONY: help fmt lint test run-api run-worker dev install \
        cache-up cache-down cache-logs cache-ping cache-cli \
        dev-sidecar dev-mastra stack stack-down

# Container runtime. Override with `make DOCKER=podman <target>`.
DOCKER ?= docker
# Pogocache (L1 cache) — mirrors docker-compose.yml. RESP2-only, binds 127.0.0.1:9401.
CACHE_NAME := cc-pogocache
CACHE_PORT := 9401

help:              ## list available targets
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

install:           ## editable install with dev + graph extras
	pip install -e ".[dev,graph]"

fmt:               ## format
	ruff format src scripts tests

lint:              ## lint + import-sort check
	ruff check src scripts tests

test:              ## unit tests
	pytest -q

run-api:           ## PHASE 2 — FastAPI surface
	@echo "PHASE 2: uvicorn credit_credix.api.app:app --reload"

run-worker:        ## PHASE 2 — background memory writer
	@echo "PHASE 2: python -m credit_credix.workers.memory_writer"

# ── Local dev stack ─────────────────────────────────────────────────────────────
# Pogocache runs as a container; the two app services run as local processes.
# `docker run` (not compose) sidesteps the podman compose version-mismatch on this box.

cache-up:          ## start Pogocache (idempotent) on :9401
	@if redis-cli -p $(CACHE_PORT) -2 PING >/dev/null 2>&1; then \
		echo "Pogocache already serving :$(CACHE_PORT) — skipping"; \
	elif [ "$$($(DOCKER) ps -aq -f name=^$(CACHE_NAME)$$)" ]; then \
		$(DOCKER) start $(CACHE_NAME) >/dev/null && echo "started existing $(CACHE_NAME)"; \
	else \
		$(DOCKER) run -d --name $(CACHE_NAME) --network host --restart unless-stopped \
			docker.io/pogocache/pogocache:latest --maxmemory 75% --evict yes >/dev/null \
			&& echo "created $(CACHE_NAME) on :$(CACHE_PORT)"; \
	fi

cache-down:        ## stop and remove the Pogocache container
	@$(DOCKER) rm -f $(CACHE_NAME) 2>/dev/null && echo "removed $(CACHE_NAME)" || echo "$(CACHE_NAME) not running"

cache-logs:        ## follow Pogocache logs
	$(DOCKER) logs -f $(CACHE_NAME)

cache-ping:        ## health-check Pogocache (expect PONG)
	redis-cli -p $(CACHE_PORT) -2 PING

cache-cli:         ## interactive RESP2 shell into Pogocache
	redis-cli -p $(CACHE_PORT) -2

dev-sidecar:       ## run the Python FastAPI sidecar on :8000
	uv run uvicorn src.nodes.api.app:app --host 0.0.0.0 --port 8000 --reload

dev-mastra:        ## run the Mastra/Hono server on :3000
	cd src/mastra && bun run dev

dev: cache-up      ## start the full local stack: Pogocache + sidecar(:8000) + mastra(:3000)
	@echo "sidecar → :8000   mastra → :3000   (Ctrl-C to stop)"
	@$(MAKE) -j2 dev-sidecar dev-mastra

stack: dev         ## alias for `make dev`

stack-down: cache-down  ## tear down the cache (app processes stop on Ctrl-C)
