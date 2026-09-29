import { type NextRequest, NextResponse } from "next/server";

// ElevenLabs text-to-speech. Key stays server-side; the browser posts reply text to this
// same-origin route and gets back audio, never talking to ElevenLabs directly. Mirrors /api/stt.
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "JBFqnCBsd6RMkjVDRZzb"; // default: George
const MODEL_ID = process.env.ELEVENLABS_TTS_MODEL || "eleven_turbo_v2_5"; // fast, chat-friendly
const MAX_CHARS = 2500; // guardrail against runaway synthesis cost/latency

export async function POST(req: NextRequest) {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) {
    return NextResponse.json(
      { error: "Voice replies are not configured (ELEVENLABS_API_KEY missing)." },
      { status: 503 },
    );
  }

  try {
    const { text } = (await req.json().catch(() => ({}))) as { text?: string };
    const clean = (text ?? "").trim().slice(0, MAX_CHARS);
    if (!clean) {
      return NextResponse.json({ error: "No text provided." }, { status: 400 });
    }

    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}?output_format=mp3_44100_128`,
      {
        method: "POST",
        headers: { "xi-api-key": key, "Content-Type": "application/json", Accept: "audio/mpeg" },
        body: JSON.stringify({
          text: clean,
          model_id: MODEL_ID,
          voice_settings: { stability: 0.4, similarity_boost: 0.75 },
        }),
        signal: req.signal,
      },
    );

    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => "");
      return NextResponse.json(
        { error: "Speech synthesis failed.", status: res.status, detail: detail.slice(0, 300) },
        { status: 502 },
      );
    }

    // Stream the audio straight back to the browser.
    return new NextResponse(res.body, {
      status: 200,
      headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" },
    });
  } catch (e) {
    const detail = e instanceof Error ? e.message : "unknown";
    return NextResponse.json({ error: "Text-to-speech proxy error.", detail }, { status: 502 });
  }
}
