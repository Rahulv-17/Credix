// Turn parsed statement text (markdown from datalab, or plain text from unpdf) into chunked JSON so
// the agent can access it piece by piece instead of swallowing one giant blob. Markdown-aware:
// splits on headings first, then windows any oversized section. Pure + deterministic, no deps.

export interface StatementChunk {
  id: string
  index: number
  heading: string
  text: string
  chars: number
}

export interface StatementDocument {
  meta: { source: string; pages: number | null; chars: number; uploadedAt: string }
  chunks: StatementChunk[]
}

const MAX_CHUNK_CHARS = 1200
const OVERLAP_CHARS = 150

// Split one long body into windows on paragraph/line boundaries, with a little overlap for context.
function windowSplit(body: string): string[] {
  if (body.length <= MAX_CHUNK_CHARS) return [body]
  const out: string[] = []
  let start = 0
  while (start < body.length) {
    let end = Math.min(start + MAX_CHUNK_CHARS, body.length)
    if (end < body.length) {
      // prefer to break on a newline, else a space, within the window
      const slice = body.slice(start, end)
      const nl = slice.lastIndexOf('\n')
      const sp = slice.lastIndexOf(' ')
      const brk = nl > MAX_CHUNK_CHARS * 0.5 ? nl : sp > MAX_CHUNK_CHARS * 0.5 ? sp : -1
      if (brk > 0) end = start + brk
    }
    out.push(body.slice(start, end).trim())
    if (end >= body.length) break
    start = Math.max(end - OVERLAP_CHARS, start + 1)
  }
  return out.filter(Boolean)
}

export function chunkStatement(
  text: string,
  meta: { source: string; pages: number | null },
): StatementDocument {
  const clean = (text ?? '').replace(/\r\n/g, '\n').trim()
  const lines = clean.split('\n')

  // Group lines into sections by markdown heading.
  const sections: { heading: string; body: string[] }[] = []
  let current = { heading: 'Overview', body: [] as string[] }
  for (const line of lines) {
    const h = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/)
    if (h) {
      if (current.body.length) sections.push(current)
      current = { heading: h[2].trim() || 'Section', body: [] }
    } else {
      current.body.push(line)
    }
  }
  if (current.body.length) sections.push(current)
  if (!sections.length) sections.push({ heading: 'Overview', body: [clean] })

  const chunks: StatementChunk[] = []
  let idx = 0
  for (const s of sections) {
    const body = s.body.join('\n').trim()
    if (!body) continue
    const parts = windowSplit(body)
    parts.forEach((part, i) => {
      const heading = parts.length > 1 ? `${s.heading} (part ${i + 1})` : s.heading
      chunks.push({ id: `c${idx + 1}`, index: idx, heading, text: part, chars: part.length })
      idx += 1
    })
  }

  return {
    meta: { source: meta.source, pages: meta.pages, chars: clean.length, uploadedAt: new Date().toISOString() },
    chunks,
  }
}
