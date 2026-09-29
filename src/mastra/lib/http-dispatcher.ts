import { setGlobalDispatcher, Agent } from 'undici'

// Outbound HTTPS keep-alive for Node's built-in fetch. undici's default keepAliveTimeout is 4s,
// shorter than the gap between chat turns, so every turn paid a fresh TCP+TLS handshake to
// api.exa.ai (and periodically api.x.ai). 60s covers normal turn cadence.
//
// This works because built-in fetch reads the dispatcher from the cross-realm
// Symbol.for('undici.globalDispatcher.1') registry, which the npm copy shares — but ONLY while the
// npm undici major matches the runtime's bundled major (Node 20/22 bundle 6.x; check
// `process.versions.undici`). Revisit the pin on a Node 24 upgrade (bundles undici 7).
//
// A server's own `Keep-Alive: timeout=` hint below 60s still wins; the probe trace (absence of
// tls.connect under turn-2+ spans) is the only proof this bites, not this file.
//
// Bun's fetch ignores undici's global dispatcher entirely — skip under `bun test` / bun runs.
if (!process.versions.bun) {
  setGlobalDispatcher(
    new Agent({ keepAliveTimeout: 60_000, keepAliveMaxTimeout: 600_000 }),
  )
}
