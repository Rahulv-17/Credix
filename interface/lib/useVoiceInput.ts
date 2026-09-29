import { useCallback, useRef, useState } from "react";

export type VoiceStatus = "idle" | "recording" | "transcribing" | "error";

/**
 * Microphone voice input via ElevenLabs Scribe.
 *
 * Flow: getUserMedia -> MediaRecorder -> on stop, POST the audio blob to /api/stt
 * (server-side proxy that holds the ElevenLabs key) -> deliver the transcript.
 * The live MediaStream is exposed so a visualizer can render real mic levels.
 */
export function useVoiceInput(onTranscript: (text: string) => void) {
  const [status, setStatus] = useState<VoiceStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const cancelledRef = useRef(false);

  const releaseStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setStream(null);
  }, []);

  const start = useCallback(async () => {
    setError(null);
    cancelledRef.current = false;

    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setError("Microphone is not available in this browser.");
      setStatus("error");
      return;
    }

    try {
      const s = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      streamRef.current = s;
      setStream(s);
      chunksRef.current = [];

      const mime = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "";
      const rec = mime ? new MediaRecorder(s, { mimeType: mime }) : new MediaRecorder(s);
      recorderRef.current = rec;

      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      rec.onstop = async () => {
        releaseStream();
        if (cancelledRef.current) {
          setStatus("idle");
          return;
        }
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || "audio/webm" });
        if (blob.size === 0) {
          setStatus("idle");
          return;
        }
        setStatus("transcribing");
        try {
          const form = new FormData();
          // Name the file by the recorded MIME type so STT does not mis-hint the format (Safari
          // records audio/mp4, not webm). Falls back to webm when the type is unknown.
          const ext = blob.type.includes("mp4")
            ? "mp4"
            : blob.type.includes("ogg")
              ? "ogg"
              : "webm";
          form.append("file", blob, `audio.${ext}`);
          const res = await fetch("/api/stt", { method: "POST", body: form });
          const data = (await res.json().catch(() => ({}))) as {
            text?: string;
            error?: string;
          };
          if (!res.ok || !data.text) {
            setError(data.error || "Couldn't understand that. Please try again.");
            setStatus("error");
            return;
          }
          setStatus("idle");
          onTranscript(data.text);
        } catch (err) {
          setError(err instanceof Error ? err.message : "Transcription failed.");
          setStatus("error");
        }
      };

      rec.start();
      setStatus("recording");
    } catch (err) {
      const name = (err as Error)?.name;
      setError(
        name === "NotAllowedError" || name === "SecurityError"
          ? "Microphone permission denied."
          : "Couldn't access the microphone.",
      );
      setStatus("error");
      releaseStream();
    }
  }, [onTranscript, releaseStream]);

  // Finish recording and transcribe.
  const stop = useCallback(() => {
    const rec = recorderRef.current;
    if (rec && rec.state !== "inactive") rec.stop();
  }, []);

  // Abort without transcribing.
  const cancel = useCallback(() => {
    cancelledRef.current = true;
    const rec = recorderRef.current;
    if (rec && rec.state !== "inactive") {
      rec.stop();
    } else {
      releaseStream();
      setStatus("idle");
    }
    setError(null);
  }, [releaseStream]);

  return { status, error, stream, start, stop, cancel };
}
