"use client";

import { useState, useEffect, useRef } from "react";
import { AssistantRuntimeProvider, useAssistantRuntime } from "@assistant-ui/react";
import { Gemini } from "@/components/gemini";
import { useCredixRuntime } from "@/lib/useCredixRuntime";
import { useTtsProvider, TtsProvider } from "@/lib/useTts";
import type { AuthState } from "@/lib/auth";
import { PhoneInputScreen } from "@/components/ui/phone-input-screen";

const AUTH_KEY = "credix_auth";
const SESSION_KEY = "credix_session_id";

function getStoredAuth(): AuthState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(AUTH_KEY);
    return raw ? (JSON.parse(raw) as AuthState) : null;
  } catch {
    return null;
  }
}

function storeAuth(auth: AuthState) {
  if (typeof window === "undefined") return;
  localStorage.setItem(AUTH_KEY, JSON.stringify(auth));
}

function clearAuth() {
  if (typeof window === "undefined") return;
  localStorage.removeItem(AUTH_KEY);
  localStorage.removeItem(SESSION_KEY);
}

// Fires one opening turn so the credix greets first (reveals the profile + guides).
// The user never has to type to start. Guarded so it runs once, only on a fresh thread.
function AutoOpener() {
  const runtime = useAssistantRuntime();
  const fired = useRef(false);
  useEffect(() => {
    if (fired.current) return;
    const thread = runtime.thread;
    // Only open if the conversation is empty (don't re-greet on a thread with history).
    if (thread.getState().messages.length > 0) return;
    fired.current = true;
    thread.append({ role: "user", content: [{ type: "text", text: "Hi" }] });
  }, [runtime]);
  return null;
}

// Hooks live here so they're never called conditionally.
function AuthenticatedApp({ auth, onLogout }: { auth: AuthState; onLogout: () => void }) {
  // Reply voice: the runtime hands each assistant reply to speak(), which only plays when the
  // user has turned voice on (default off). Controls are shared with the UI via TtsProvider.
  const tts = useTtsProvider();
  const runtime = useCredixRuntime(auth.mobile, auth.sessionId, tts.speak);
  return (
    <TtsProvider controls={tts}>
      <AssistantRuntimeProvider runtime={runtime}>
        <AutoOpener />
        <Gemini onLogout={onLogout} />
      </AssistantRuntimeProvider>
    </TtsProvider>
  );
}

export function Assistant() {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const stored = getStoredAuth();
    if (stored) setAuth(stored);
    setMounted(true);
  }, []);

  function handleVerified(newAuth: AuthState) {
    storeAuth(newAuth);
    setAuth(newAuth);
  }

  // Clear stored auth + session and return to the phone screen.
  function handleLogout() {
    clearAuth();
    setAuth(null);
  }

  if (!mounted) return null;
  if (!auth) return <PhoneInputScreen onVerified={handleVerified} />;
  return <AuthenticatedApp auth={auth} onLogout={handleLogout} />;
}
