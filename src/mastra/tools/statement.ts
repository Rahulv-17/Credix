import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { getStatementDoc, searchStatement } from '../lib/statement-store'
import { resolveUserId } from '../lib/normalize-user-id'

// Lets an agent read the user's uploaded, parsed statement (chunked JSON) on demand.
// Three modes, chosen by which optional input is set:
//   - chunk_id: return that exact chunk
//   - query: keyword-search the chunks, return the top matches
//   - neither: return the index (headings + ids + meta) so the agent can pick a chunk
export const getStatement = createTool({
  id: 'getStatement',
  description:
    "Read the user's uploaded bank/credit statement, which is stored as chunked JSON. Call with a `query` to find relevant chunks (e.g. 'closing balance', 'EMI', 'salary credit'), or `chunk_id` to fetch a specific chunk, or neither to list the available chunk headings. Returns { available } = false when the user has not uploaded a statement.",
  inputSchema: z.object({
    user_id: z
      .string()
      .optional()
      .describe('Leave this out. The server supplies the user id from the request context.'),
    query: z.string().optional().describe('Keyword(s) to search the statement chunks for.'),
    chunk_id: z.string().optional().describe('Fetch one specific chunk by its id (e.g. "c3").'),
  }),
  outputSchema: z.record(z.string(), z.unknown()),
  execute: async (inputData, context) => {
    const { query, chunk_id } = inputData
    // Context-first: server-verified user_id from the central request context, arg as fallback.
    const user_id = resolveUserId(inputData.user_id, context)
    const doc = getStatementDoc(user_id)
    if (!doc) {
      return { available: false, message: 'No statement uploaded for this user.' }
    }

    if (chunk_id) {
      const chunk = doc.chunks.find(c => c.id === chunk_id)
      return chunk
        ? { available: true, mode: 'chunk', meta: doc.meta, chunk }
        : { available: true, mode: 'chunk', meta: doc.meta, error: `No chunk ${chunk_id}` }
    }

    if (query) {
      const matches = searchStatement(user_id, query, 3)
      return { available: true, mode: 'search', query, meta: doc.meta, chunks: matches }
    }

    // Index: just the headings + ids so the agent can navigate without pulling all text.
    return {
      available: true,
      mode: 'index',
      meta: doc.meta,
      index: doc.chunks.map(c => ({ id: c.id, heading: c.heading, chars: c.chars })),
    }
  },
})
