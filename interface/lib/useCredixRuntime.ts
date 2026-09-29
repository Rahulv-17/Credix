import { useLocalRuntime, type ChatModelAdapter } from "@assistant-ui/react";
import { useMemo, useRef } from "react";

const SESSION_KEY = "credix_session_id";
const REQUEST_TIMEOUT_MS = 60_000;

interface ChatResponse {
  response?: string;
  session_id?: string;
  active_skill?: string;
  error?: string;
  detail?: string;
}

export function useCredixRuntime(
  mobile: string,
  sessionId: string,
  onReply?: (text: string) => void,
) {
  const mobileRef = useRef(mobile);
  mobileRef.current = mobile;
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  // Kept in a ref so the memoized adapter always calls the latest callback (e.g. speak reply).
  const onReplyRef = useRef(onReply);
  onReplyRef.current = onReply;

  const adapter = useMemo<ChatModelAdapter>(
    () => ({
      async *run({ messages, abortSignal }) {
        const latest = messages[messages.length - 1];
        if (!latest || latest.role !== "user") return;

        const content = latest.content
          .map((c) => (c.type === "text" ? c.text : ""))
          .join("");

        // Prefer the backend-issued session id if we have one persisted.
        const stored =
          typeof window !== "undefined"
            ? localStorage.getItem(SESSION_KEY)
            : null;
        const session_id = stored || sessionIdRef.current;

        const timeoutCtrl = new AbortController();
        const timer = setTimeout(
          () => timeoutCtrl.abort(),
          REQUEST_TIMEOUT_MS,
        );
        const onAbort = () => timeoutCtrl.abort();
        // If the caller's signal is already aborted, abort now: addEventListener would not fire
        // for an event that already dispatched, so an already-cancelled turn would still fetch.
        if (abortSignal?.aborted) timeoutCtrl.abort();
        else abortSignal?.addEventListener("abort", onAbort, { once: true });

        try {
          const res = await fetch("/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              mobile: mobileRef.current,
              message: content,
              session_id,
              channel: "web",
            }),
            signal: timeoutCtrl.signal,
          });

          const data = (await res.json().catch(() => ({}))) as ChatResponse;

          // Success and not_found both return 200 with a user-facing response.
          if (res.ok && data.response) {
            if (data.session_id && typeof window !== "undefined") {
              localStorage.setItem(SESSION_KEY, data.session_id);
            }
            onReplyRef.current?.(data.response);
            yield {
              content: [{ type: "text" as const, text: data.response }],
            };
            return;
          }

          const text =
            res.status === 502
              ? "I'm having trouble reaching your data right now. Please try again in a moment."
              : data.error || "Something went wrong. Please try again.";
          onReplyRef.current?.(text);
          yield { content: [{ type: "text" as const, text }] };
        } catch (err) {
          // User-initiated abort: assistant-ui already handles it — stay silent.
          if (abortSignal?.aborted) return;
          const timedOut = (err as Error)?.name === "AbortError";
          const text = timedOut
            ? "That took too long. Please try again."
            : "I'm having trouble connecting right now.";
          onReplyRef.current?.(text);
          yield { content: [{ type: "text" as const, text }] };
        } finally {
          clearTimeout(timer);
          abortSignal?.removeEventListener("abort", onAbort);
        }
      },
    }),
    [], // stable — live values via refs
  );

  return useLocalRuntime(adapter);
}
