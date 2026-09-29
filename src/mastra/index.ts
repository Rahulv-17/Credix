import { Mastra } from '@mastra/core'
import { libsqlStore } from './lib/storage'
import { credixWorkflow } from './workflows/credix-workflow'
import { masterAgent, creditCardAgent, credixAgent } from './agents'
import { buildObservability } from './lib/langfuse-observability'

// Re-export so existing importers of `./index` keep working. The instance itself lives in
// ./lib/storage to break the index → agents → memory → index cycle (see that file).
export { libsqlStore }

// Langfuse AI tracing. Undefined (omitted) unless LANGFUSE_* keys are set, so tests and unconfigured
// runs are unaffected and no data leaves the process. Exported so server.ts can flush its buffered
// spans on shutdown. See lib/langfuse-observability.ts.
export const observability = buildObservability()

export const mastra = new Mastra({
  storage: libsqlStore,
  agents: {
    masterAgent,
    creditCardAgent,
    credixAgent,
  },
  workflows: {
    credixWorkflow,
  },
  ...(observability ? { observability } : {}),
})
