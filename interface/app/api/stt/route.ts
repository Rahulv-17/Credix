import { type NextRequest, NextResponse } from "next/server";

// ElevenLabs Scribe (speech-to-text). Key stays server-side; the browser posts audio to
// this same-origin route, never to ElevenLabs directly. Mirrors the /api/chat proxy shape.
const ELEVENLABS_STT_URL = "https://api.elevenlabs.io/v1/speech-to-text";
const MODEL_ID = process.env.ELEVENLABS_STT_MODEL || "scribe_v2";
// Cap upload size: spoken commands are small, so reject an oversize POST (before buffering the
// body) rather than let it spike memory or run up ElevenLabs cost/latency. NaN/unset -> 10 MB.
const MAX_AUDIO_BYTES = Number(process.env.STT_MAX_BYTES) || 10 * 1024 * 1024;

// ElevenLabs Scribe auto-detects the codec, but the filename is its first format hint, so forward
// the real one instead of a hardcoded audio.webm (Safari records audio/mp4, which that name would
// mislabel). Prefer the client-provided File name; fall back to the MIME type the client records.
export function sttFilename(file: Blob): string {
  if (file instanceof File && file.name) return file.name;
  const ext = file.type.includes("mp4") ? "mp4" : file.type.includes("ogg") ? "ogg" : "webm";
  return `audio.${ext}`;
}

export async function POST(req: NextRequest) {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) {
    return NextResponse.json(
      { error: "Voice input is not configured (ELEVENLABS_API_KEY missing)." },
      { status: 503 },
    );
  }

  try {
    const declaredLen = Number(req.headers.get("content-length") ?? 0);
    if (declaredLen > MAX_AUDIO_BYTES) {
      return NextResponse.json({ error: "Audio too large." }, { status: 413 });
    }

    const inForm = await req.formData();
    const file = inForm.get("file");
    if (!(file instanceof Blob) || file.size === 0) {
      return NextResponse.json({ error: "No audio provided." }, { status: 400 });
    }
    if (file.size > MAX_AUDIO_BYTES) {
      return NextResponse.json({ error: "Audio too large." }, { status: 413 });
    }

    const out = new FormData();
    out.append("file", file, sttFilename(file));
    out.append("model_id", MODEL_ID);
    // Short spoken commands: drop non-speech event tags for a clean transcript.
    out.append("tag_audio_events", "false");

    const res = await fetch(ELEVENLABS_STT_URL, {
      method: "POST",
      headers: { "xi-api-key": key }, // do NOT set Content-Type; fetch adds the multipart boundary
      body: out,
      signal: req.signal,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return NextResponse.json(
        { error: "Transcription failed.", status: res.status, detail: detail.slice(0, 300) },
        { status: 502 },
      );
    }

    const data = (await res.json()) as { text?: string };
    return NextResponse.json({ text: (data.text ?? "").trim() });
  } catch (e) {
    const detail = e instanceof Error ? e.message : "unknown";
    return NextResponse.json({ error: "Speech-to-text proxy error.", detail }, { status: 502 });
  }
}
