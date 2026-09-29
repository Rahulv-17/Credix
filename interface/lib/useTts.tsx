"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

const TTS_KEY = "credix_tts_enabled";

export interface TtsControls {
  /** Whether replies are read aloud automatically. */
  enabled: boolean;
  /** True while audio is being fetched or playing. */
  speaking: boolean;
  error: string | null;
  /** Speak text. Skipped when disabled unless `force` (e.g. a manual "play" tap). */
  speak: (text: string, opts?: { force?: boolean }) => void;
  stop: () => void;
  toggle: () => void;
}

// Reduce markdown to something a voice should actually read: drop code fences, turn links into
// their label, strip headings/emphasis/bullets. Keeps the spoken reply clean.
function toSpeakable(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/(\*\*|__|\*|_|~~)/g, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export function useTtsProvider(): TtsControls {
  const [enabled, setEnabled] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);
  const ctrlRef = useRef<AbortController | null>(null);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  // Restore the user's preference (defaults to off, so nothing autoplays unexpectedly).
  useEffect(() => {
    if (typeof window === "undefined") return;
    setEnabled(localStorage.getItem(TTS_KEY) === "1");
  }, []);

  const cleanup = useCallback(() => {
    ctrlRef.current?.abort();
    ctrlRef.current = null;
    const a = audioRef.current;
    if (a) {
      a.pause();
      a.removeAttribute("src");
    }
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
  }, []);

  const stop = useCallback(() => {
    cleanup();
    setSpeaking(false);
  }, [cleanup]);

  const speak = useCallback(
    async (raw: string, opts?: { force?: boolean }) => {
      if (!opts?.force && !enabledRef.current) return;
      const text = toSpeakable(raw || "");
      if (!text) return;

      cleanup(); // interrupt any in-flight or playing reply
      setError(null);
      const ctrl = new AbortController();
      ctrlRef.current = ctrl;
      setSpeaking(true);

      try {
        const res = await fetch("/api/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
          signal: ctrl.signal,
        });
        if (!res.ok) {
          const d = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(d.error || `Speech failed (${res.status})`);
        }
        const blob = await res.blob();
        if (ctrl.signal.aborted) return;

        const url = URL.createObjectURL(blob);
        urlRef.current = url;
        const audio = audioRef.current ?? (audioRef.current = new Audio());
        audio.src = url;
        audio.onended = () => {
          setSpeaking(false);
          if (urlRef.current) {
            URL.revokeObjectURL(urlRef.current);
            urlRef.current = null;
          }
        };
        audio.onerror = () => setSpeaking(false);
        await audio.play();
      } catch (e) {
        if ((e as Error)?.name === "AbortError") return;
        setError(e instanceof Error ? e.message : "Playback failed");
        setSpeaking(false);
      }
    },
    [cleanup],
  );

  const toggle = useCallback(() => {
    setEnabled((prev) => {
      const next = !prev;
      if (typeof window !== "undefined") {
        localStorage.setItem(TTS_KEY, next ? "1" : "0");
      }
      if (!next) stop(); // turning off silences anything currently playing
      return next;
    });
  }, [stop]);

  useEffect(() => cleanup, [cleanup]);

  return useMemo(
    () => ({ enabled, speaking, error, speak, stop, toggle }),
    [enabled, speaking, error, speak, stop, toggle],
  );
}

const TtsCtx = createContext<TtsControls | null>(null);

export function TtsProvider({
  controls,
  children,
}: {
  controls: TtsControls;
  children: ReactNode;
}) {
  return <TtsCtx.Provider value={controls}>{children}</TtsCtx.Provider>;
}

export function useTts(): TtsControls {
  const ctx = useContext(TtsCtx);
  if (!ctx) throw new Error("useTts must be used within a TtsProvider");
  return ctx;
}
