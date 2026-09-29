/// <reference types="bun-types" />
// Capture the REAL module first (this file is imported before any test calls mock.module), so the
// factory can spread all real exports (MessageList, etc.) and override ONLY Agent — otherwise
// replacing the whole module breaks internal consumers that import other named exports.
import * as realAgentModule from '@mastra/core/agent'

/**
 * Shared @mastra/core/agent stub for tests.
 *
 * Why shared: the specialist agents and understandStep's classifier agent are module-level / memoized
 * singletons, constructed the first time their module is imported. bun has one module registry across
 * all test files, so whichever test file imports those modules first fixes the Agent class binding.
 * If each test file registered its own stub, only the first one would take effect. Instead every
 * agent-touching test registers THIS factory, and every stub instance delegates to the single mutable
 * `agentMockState` — so any test can drive `generate` regardless of which file built the singleton.
 *
 * Usage in a test file (mock.module must be called before importing code that builds agents):
 *   import { agentMockState, agentMockFactory } from './agent-mock'
 *   mock.module('@mastra/core/agent', agentMockFactory)
 *   beforeEach(() => { agentMockState.reset() })
 *   agentMockState.generate = async () => ({ object: {...}, text: '...', steps: [...] })
 */
export const agentMockState = {
  // Set per test. understandStep reads `.object`; makeAgentStep reads `.text` / `.steps`.
  generate: async (_msg: unknown, _opts: unknown): Promise<any> => ({
    object: undefined,
    text: 'mock agent response',
    steps: [],
  }),
  calls: 0,
  reset() {
    this.calls = 0
    this.generate = async () => ({ object: undefined, text: 'mock agent response', steps: [] })
  },
}

export function agentMockFactory() {
  // EXTEND the real Agent so the stub inherits Mastra's lifecycle methods (__setLogger,
  // __registerMastra, etc.) that `new Mastra({ agents })` calls during registration — a bare class
  // would crash there. We override only generate() (no network) and getMemory(), and stash config
  // for assertions.
  const RealAgent = realAgentModule.Agent as any
  return {
    ...realAgentModule,
    Agent: class extends RealAgent {
      config: any
      constructor(cfg: any) {
        super(cfg)
        this.config = cfg
      }
      async generate(msg: unknown, opts: unknown) {
        agentMockState.calls++
        return agentMockState.generate(msg, opts)
      }
      async getMemory() {
        return this.config?.memory
      }
    },
  }
}
