/// <reference types="bun-types" />

// Shared exa-js stub, same pattern as agent-mock.ts and for the same reason: tools/exa.ts memoises
// its client on first search, so the FIRST factory to construct wins for the whole bun test
// process. Every file that needs grounding offline registers this ONE factory
// (`mock.module('exa-js', exaMockFactory)`) and drives behaviour through the shared mutable state.

const DEFAULT_RESULTS = [
  {
    title: 'RBI repo rate explainer',
    url: 'https://example.org/rates',
    text: 'repo rate is 6.5% this quarter',
    highlights: ['repo rate is 6.5%'],
  },
]

export const exaMockState = {
  calls: 0,
  fail: false,
  lastQuery: '', // the query string the last search() received — lets tests assert what left the service
  results: DEFAULT_RESULTS as { title: string; url: string; text: string; highlights: string[] }[],
  reset() {
    this.calls = 0
    this.fail = false
    this.lastQuery = ''
    this.results = DEFAULT_RESULTS
  },
}

export const exaMockFactory = () => ({
  default: class ExaStub {
    async search(query: string, _opts: unknown) {
      exaMockState.calls++
      exaMockState.lastQuery = query
      if (exaMockState.fail) throw new Error('exa down')
      return { results: exaMockState.results }
    }
  },
})
