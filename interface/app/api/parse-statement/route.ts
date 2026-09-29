import { type NextRequest, NextResponse } from "next/server";
import { extractText, getDocumentProxy } from "unpdf";
import { chunkStatement } from "@/lib/chunk-statement";

const CREDIX_API_URL = process.env.CREDIX_API_URL || "http://localhost:3000";

// Statement PDF parser. The browser posts a PDF to this same-origin route; we return extracted
// text/markdown. Uses datalab.to (Marker) when DATALAB_API_KEY is set — the better parser for
// tables/layout — and falls back to unpdf (free, local, offline) otherwise, so it works today
// with no key. Parsed output is meant to be fed to the credix agent later; for now the route
// just returns it (see TODO at the bottom). Mirrors the /api/stt proxy shape.
//
// Prereqs to enable datalab: set DATALAB_API_KEY in interface/.env.local (free tier at datalab.to,
// no credit card). Without it, unpdf handles extraction locally.

const DATALAB_URL = "https://www.datalab.to/api/v1/convert";
const DATALAB_POLL_TIMEOUT_MS = 60_000; // Marker is async; poll the check_url until complete
const DATALAB_POLL_INTERVAL_MS = 2_000;
const MAX_BYTES = 15 * 1024 * 1024; // 15 MB guardrail

type ParseResult = { source: "datalab" | "unpdf"; text: string; pages?: number };

// ── datalab.to (Marker) ─────────────────────────────────────────────────────────
// Submit returns a request_check_url; poll it until status === "complete", then read markdown.
async function parseWithDatalab(file: Blob, name: string, key: string): Promise<ParseResult> {
  const form = new FormData();
  form.append("file", file, name);
  form.append("output_format", "markdown");
  form.append("mode", "balanced");

  const submit = await fetch(DATALAB_URL, {
    method: "POST",
    headers: { "X-API-Key": key }, // do NOT set Content-Type; fetch adds the multipart boundary
    body: form,
  });
  if (!submit.ok) {
    const detail = await submit.text().catch(() => "");
    throw new Error(`datalab submit failed (${submit.status}): ${detail.slice(0, 200)}`);
  }
  const init = (await submit.json()) as { request_check_url?: string; success?: boolean; error?: string };
  const checkUrl = init.request_check_url;
  if (!checkUrl) throw new Error(`datalab: no request_check_url (${init.error ?? "unknown"})`);

  const deadline = Date.now() + DATALAB_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, DATALAB_POLL_INTERVAL_MS));
    const poll = await fetch(checkUrl, { headers: { "X-API-Key": key } });
    if (!poll.ok) continue;
    const res = (await poll.json()) as { status?: string; markdown?: string; page_count?: number; error?: string };
    if (res.status === "complete") {
      return { source: "datalab", text: res.markdown ?? "", pages: res.page_count };
    }
    if (res.status === "failed" || res.error) {
      throw new Error(`datalab processing failed: ${res.error ?? "unknown"}`);
    }
  }
  throw new Error("datalab: polling timed out");
}

// ── unpdf (free, local fallback) ─────────────────────────────────────────────────
async function parseWithUnpdf(file: Blob): Promise<ParseResult> {
  const buf = new Uint8Array(await file.arrayBuffer());
  const pdf = await getDocumentProxy(buf);
  const { text, totalPages } = await extractText(pdf, { mergePages: true });
  return { source: "unpdf", text: (text ?? "").trim(), pages: totalPages };
}

export async function POST(req: NextRequest) {
  try {
    const inForm = await req.formData();
    const file = inForm.get("file");
    if (!(file instanceof Blob) || file.size === 0) {
      return NextResponse.json({ error: "No file provided." }, { status: 400 });
    }
    if (file.size > MAX_BYTES) {
      return NextResponse.json({ error: "File too large (max 15 MB)." }, { status: 413 });
    }
    const name = (file instanceof File && file.name) || "statement.pdf";

    const key = process.env.DATALAB_API_KEY;
    let result: ParseResult;
    if (key) {
      // datalab preferred; if it errors, fall back to local parsing so an upload never hard-fails.
      try {
        result = await parseWithDatalab(file, name, key);
      } catch (e) {
        console.warn(`[parse-statement] datalab failed, falling back to unpdf: ${e instanceof Error ? e.message : e}`);
        result = await parseWithUnpdf(file);
      }
    } else {
      result = await parseWithUnpdf(file);
    }

    // Convert to chunked JSON so the agent can access it piece by piece.
    const document = chunkStatement(result.text, { source: result.source, pages: result.pages ?? null });

    // Feed it to the agent: ingest into the Mastra backend, keyed by the user's mobile, so the
    // getStatement tool can serve it on later turns. Best-effort — a failed ingest still returns
    // the parsed text to the client.
    const mobile = (inForm.get("mobile") as string) || "";
    const session_id = (inForm.get("session_id") as string) || undefined;
    let ingested = false;
    if (mobile) {
      try {
        const ing = await fetch(`${CREDIX_API_URL}/v1/statement`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mobile, session_id, document }),
        });
        ingested = ing.ok;
        if (!ing.ok) {
          console.warn(`[parse-statement] ingest failed (${ing.status}): ${(await ing.text()).slice(0, 200)}`);
        }
      } catch (e) {
        console.warn(`[parse-statement] ingest error: ${e instanceof Error ? e.message : e}`);
      }
    }

    return NextResponse.json({
      source: result.source,
      pages: result.pages ?? null,
      chars: result.text.length,
      chunks: document.chunks.length,
      ingested,
      document,
    });
  } catch (e) {
    const detail = e instanceof Error ? e.message : "unknown";
    return NextResponse.json({ error: "Statement parsing failed.", detail }, { status: 502 });
  }
}
