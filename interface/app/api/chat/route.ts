import { type NextRequest, NextResponse } from "next/server";

// Server-side only. The browser never sees this URL; it always calls /api/chat.
const CREDIX_API_URL =
  process.env.CREDIX_API_URL || "http://localhost:3000";

// Node runtime (not edge) so we can reach an internal backend host.
export async function POST(req: NextRequest) {
  try {
    const body = await req.text();
    const res = await fetch(`${CREDIX_API_URL}/v1/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: req.signal,
    });
    const text = await res.text();
    return new NextResponse(text, {
      status: res.status,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    const detail = e instanceof Error ? e.message : "unknown";
    return NextResponse.json(
      { error: "Credix backend unreachable", detail },
      { status: 502 },
    );
  }
}
