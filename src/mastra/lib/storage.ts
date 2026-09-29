import { LibSQLStore } from '@mastra/libsql'

/**
 * THE single LibSQL storage instance, in its own module on purpose.
 *
 * Both `index.ts` (the Mastra instance) and `memory/index.ts` (credixMemory) need this exact
 * instance. If `memory/index.ts` imported it from `index.ts`, registering the agents in `index.ts`
 * would create an `index → agents → memory → index` cycle, and ESM hoists imports above the
 * `libsqlStore` const — so `memory` would read it before it's initialised. Keeping it here breaks
 * the cycle: `memory` imports `../lib/storage`, never `../index`.
 */
export const libsqlStore = new LibSQLStore({
  id: 'credix-storage',
  url: process.env.MASTRA_DB_URL ?? 'file:./mastra.db',
})
