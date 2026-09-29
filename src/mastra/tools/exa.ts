import { createTool } from '@mastra/core/tools'
import Exa from 'exa-js'
import { z } from 'zod'

// Web search via Exa (https://exa.ai). Gives agents fresh, real-world context (current rates,
// product terms, news) that the model's training data can't cover. Needs EXA_API_KEY.
//
// The search behaviour (fast retrieval, India-relevant results, spammy domains excluded,
// highlighted snippets) is baked in here so callers only supply the query, not the mechanics.
// Used two ways: (1) as the `exaSearch` tool an agent can call mid-reasoning, and (2) by the
// per-turn grounding step (see makeAgentStep) via the exported `webSearch` helper.
const EXCLUDE_DOMAINS = ['reddit.com', 'x.com', 'quora.com']

export const EXA_CATEGORIES = [
  'company',
  'research paper',
  'news',
  'pdf',
  'personal site',
  'financial report',
  'people',
] as const
export type ExaCategory = (typeof EXA_CATEGORIES)[number]

export interface WebResult {
  title: string
  url: string
  excerpt: string
}

export interface WebSearchOptions {
  numResults?: number
  category?: ExaCategory
  startPublishedDate?: string
  endPublishedDate?: string
}

let client: Exa | null = null
function exaClient(): Exa {
  const apiKey = process.env.EXA_API_KEY
  if (!apiKey) throw new Error('EXA_API_KEY is not set')
  if (!client) client = new Exa(apiKey)
  return client
}

// Core search. Returns lightweight {title, url, excerpt} rows the LLM can read directly.
export async function webSearch(query: string, opts: WebSearchOptions = {}): Promise<WebResult[]> {
  const { numResults = 5, category, startPublishedDate, endPublishedDate } = opts

  const response = await exaClient().search(query, {
    type: 'fast',
    numResults,
    excludeDomains: EXCLUDE_DOMAINS,
    userLocation: 'IN',
    ...(category ? { category } : {}),
    ...(startPublishedDate ? { startPublishedDate } : {}),
    ...(endPublishedDate ? { endPublishedDate } : {}),
    contents: { text: { maxCharacters: 800 }, highlights: true },
  })

  return (response.results ?? []).map((r) => {
    const highlights = Array.isArray(r.highlights) ? r.highlights.join(' … ') : ''
    const excerpt = (highlights || r.text || '').trim()
    return { title: r.title ?? '', url: r.url ?? '', excerpt }
  })
}

export const exaSearch = createTool({
  id: 'exaSearch',
  description:
    'Search the live web for current information (rates, product terms, news, general facts) and return top results with a short text excerpt each. Use when the answer depends on up-to-date or external information not already in the profile data. For time-sensitive topics (news, recent rate changes) set start_published_date so only recent results are returned.',
  inputSchema: z.object({
    query: z.string().min(1).describe('What to search the web for'),
    num_results: z.number().int().min(1).max(10).default(5),
    category: z
      .enum(EXA_CATEGORIES)
      .optional()
      .describe('Optional Exa content category to bias results toward, e.g. "news" for current events.'),
    start_published_date: z
      .string()
      .optional()
      .describe('ISO date; only return results published on or after this date. Use for recency.'),
    end_published_date: z
      .string()
      .optional()
      .describe('ISO date; only return results published on or before this date.'),
  }),
  outputSchema: z.object({
    results: z.array(
      z.object({
        title: z.string(),
        url: z.string(),
        excerpt: z.string(),
      }),
    ),
  }),
  execute: async (inputData) => {
    const { query, num_results, category, start_published_date, end_published_date } = inputData
    const results = await webSearch(query, {
      numResults: num_results,
      category,
      startPublishedDate: start_published_date,
      endPublishedDate: end_published_date,
    })
    return { results }
  },
})
