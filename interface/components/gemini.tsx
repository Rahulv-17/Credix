"use client";

import {
  ActionBarPrimitive,
  AuiIf,
  AttachmentPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAssistantRuntime,
  useAuiState,
} from "@assistant-ui/react";

import {
  CheckIcon,
  ChevronDownIcon,
  Cross2Icon,
  Pencil1Icon,
  ReloadIcon,
} from "@radix-ui/react-icons";
import {
  Check,
  CopyIcon,
  EllipsisVertical,
  FileText,
  Loader2,
  LogOut,
  Plus,
  SendHorizonal,
  Square,
  ThumbsDown,
  ThumbsUp,
  Volume2,
  VolumeX,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { type FC, useCallback, useEffect, useRef, useState } from "react";
import { useVoiceInput } from "@/lib/useVoiceInput";
import { useTts } from "@/lib/useTts";
import { useShallow } from "zustand/shallow";
import { MarkdownText } from "@/components/assistant-ui/markdown-text";
import { ZapIcon } from "@/components/icons/zap";
import { Orb, type AgentState as OrbState } from "@/components/ui/orb";
import { BarVisualizer, type AgentState as BarState } from "@/components/ui/bar-visualizer";
// SiriOrb removed — replaced by ElevenLabs Orb component
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/shared/dropdown-menu";

// Upload a bank/credit statement PDF. Posts to /api/parse-statement (datalab.to if configured,
// else local unpdf). For now it just parses and confirms; wiring the parsed text into the agent is
// the next step (see TODO in the route). Self-contained state so it can drop anywhere in the bar.
const UploadStatementButton: FC = () => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<"idle" | "parsing" | "done" | "error">("idle");
  const [note, setNote] = useState<string>("");

  const onPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-uploading the same file
    if (!file) return;
    setStatus("parsing");
    setNote("");
    try {
      const form = new FormData();
      form.append("file", file);
      // Include the logged-in user's mobile + session so the backend can key the statement to them
      // and the getStatement tool can serve it to the agent on later turns.
      try {
        const auth = JSON.parse(localStorage.getItem("credix_auth") || "{}");
        if (auth.mobile) form.append("mobile", auth.mobile);
        if (auth.sessionId) form.append("session_id", auth.sessionId);
      } catch {
        // no stored auth — parse still works, just won't be ingested for the agent
      }
      const res = await fetch("/api/parse-statement", { method: "POST", body: form });
      const data = (await res.json()) as {
        source?: string;
        pages?: number | null;
        chars?: number;
        chunks?: number;
        ingested?: boolean;
        error?: string;
      };
      if (!res.ok) throw new Error(data.error || `Parse failed (${res.status})`);
      setStatus("done");
      const tail = data.ingested ? "ready for Rahul" : "not linked (log in first)";
      setNote(`${data.chunks ?? 0} chunks via ${data.source} — ${tail}`);
      console.info("[statement] parsed:", data);
      setTimeout(() => setStatus("idle"), 4000);
    } catch (err) {
      setStatus("error");
      setNote(err instanceof Error ? err.message : "Upload failed");
      setTimeout(() => setStatus("idle"), 5000);
    }
  };

  return (
    <div className="flex items-center gap-2">
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf,.pdf"
        className="hidden"
        onChange={onPick}
      />
      <Button
        variant="outline"
        size="icon"
        className="rounded-full"
        aria-label="Upload statement (PDF)"
        title="Upload statement (PDF)"
        disabled={status === "parsing"}
        onClick={() => inputRef.current?.click()}
      >
        {status === "parsing" ? (
          <Loader2 size={16} strokeWidth={2} className="animate-spin" aria-hidden="true" />
        ) : status === "done" ? (
          <Check size={16} strokeWidth={2} aria-hidden="true" />
        ) : (
          <FileText size={16} strokeWidth={2} aria-hidden="true" />
        )}
      </Button>
      {note ? (
        <span
          className={`text-xs ${status === "error" ? "text-red-500" : "text-[#70757a] dark:text-[#9aa0a6]"}`}
        >
          {note}
        </span>
      ) : null}
    </div>
  );
};

const NewThreadButton: FC = () => {
  const runtime = useAssistantRuntime();
  return (
    <Button
      variant="outline"
      size="icon"
      className="rounded-full"
      aria-label="New conversation"
      onClick={() => {
        localStorage.removeItem("credix_session_id");
        window.location.reload();
      }}
    >
      <Plus size={16} strokeWidth={2} aria-hidden="true" />
    </Button>
  );
};

// Turns reply voice on/off. Enabling reads the latest reply aloud immediately — that play happens
// inside the click gesture, which also satisfies the browser's autoplay policy for later replies.
const VoiceToggleButton: FC = () => {
  const tts = useTts();
  const runtime = useAssistantRuntime();
  const onClick = () => {
    const willEnable = !tts.enabled;
    tts.toggle();
    if (willEnable) {
      const messages = runtime.thread.getState().messages;
      const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
      const text =
        lastAssistant?.content
          .map((c) => (c.type === "text" ? c.text : ""))
          .join("") ?? "";
      if (text) tts.speak(text, { force: true });
    }
  };
  return (
    <Button
      variant="outline"
      size="icon"
      className="rounded-full"
      aria-label={tts.enabled ? "Turn reply voice off" : "Turn reply voice on"}
      aria-pressed={tts.enabled}
      onClick={onClick}
    >
      {tts.speaking ? (
        <Loader2 size={16} strokeWidth={2} className="animate-spin" aria-hidden="true" />
      ) : tts.enabled ? (
        <Volume2 size={16} strokeWidth={2} aria-hidden="true" />
      ) : (
        <VolumeX size={16} strokeWidth={2} aria-hidden="true" />
      )}
    </Button>
  );
};

export const Gemini: FC<{ onLogout?: () => void }> = ({ onLogout }) => {
  return (
    <ThreadPrimitive.Root className="relative flex h-full flex-col items-stretch bg-[#f8f9fa] dark:bg-[#131314]">
      <div className="absolute top-4 left-4 z-10">
        <NewThreadButton />
      </div>
      <div className="absolute top-4 right-4 z-10 flex items-center gap-2">
        <UploadStatementButton />
        <VoiceToggleButton />
        {onLogout && (
          <Button
            variant="outline"
            size="icon"
            className="rounded-full"
            aria-label="Log out"
            onClick={onLogout}
          >
            <LogOut size={16} strokeWidth={2} aria-hidden="true" />
          </Button>
        )}
      </div>
      <AuiIf condition={(s) => s.thread.isEmpty}>
        <div className="flex h-full flex-col justify-center px-4">
          <div className="mx-auto w-full max-w-3xl">
            <div className="mb-1 flex items-center gap-3">
              <ZapIcon className="size-6 text-[#1f1f1f] dark:text-[#e3e3e3]" />
              <p className="text-black text-xl dark:text-white">Hi there</p>
            </div>
            <p className="mb-6 text-3xl text-black sm:text-4xl dark:text-white">
              Where would you like to start?
            </p>
          </div>
          <Composer />
        </div>
      </AuiIf>

      <AuiIf condition={(s) => !s.thread.isEmpty}>
        <ThreadPrimitive.Viewport className="flex grow flex-col overflow-y-scroll pt-16">
          <ThreadPrimitive.Messages components={{ Message: ChatMessage }} />
        </ThreadPrimitive.Viewport>
        <div className="space-y-2 px-4 pb-4">
          <Composer />
          <p className="text-center text-[#70757a] text-xs dark:text-[#9aa0a6]">
            Rahul may display inaccurate info, including about people, so
            double-check its responses.
          </p>
        </div>
      </AuiIf>
    </ThreadPrimitive.Root>
  );
};

const SuggestionChip: FC<{
  icon: React.ReactNode;
  children: React.ReactNode;
}> = ({ icon, children }) => (
  <button
    type="button"
    className="flex items-center gap-2 rounded-full bg-white px-4 py-2.5 text-[#444746] text-sm shadow-[0_1px_3px_rgba(0,0,0,0.12)] transition-colors hover:bg-[#f1f3f4] dark:bg-[#282a2c] dark:text-[#c4c7c5] dark:shadow-[0_1px_3px_rgba(0,0,0,0.4)] dark:hover:bg-[#333537]"
  >
    {icon}
    {children}
  </button>
);



// px of drag travel that equals 100% reveal
const DRAG_FULL = 100;
// release above this progress → commit to voice
const SNAP_THRESHOLD = 0.45;

// Orb brand colours matching the SiriOrb palette
const ORB_COLORS: [string, string] = ["#f9a8d4", "#67e8f9"]

// Maps voice state to BarVisualizer state
const BAR_STATE: Record<NonNullable<OrbState> | "idle", BarState> = {
  idle:      "connecting",
  listening: "listening",
  thinking:  "thinking",
  talking:   "speaking",
}

const Composer: FC = () => {
  const isEmpty = useAuiState((s) => s.composer.isEmpty);
  const isRunning = useAuiState((s) => s.thread.isRunning);
  const runtime = useAssistantRuntime();
  const [mode, setMode] = useState<"text" | "voice">("text");
  const [dragging, setDragging] = useState(false);
  const [dragProgress, setDragProgress] = useState(0);
  const dragOrigin = useRef<number | null>(null);

  // Voice -> transcript -> composer -> auto-send, then leave voice mode.
  const handleTranscript = useCallback(
    (text: string) => {
      const composer = runtime.thread.composer;
      composer.setText(text);
      composer.send();
      setMode("text");
      setDragProgress(0);
    },
    [runtime],
  );

  const voice = useVoiceInput(handleTranscript);

  const enterVoice = () => {
    setMode("voice");
    setDragProgress(0);
    setDragging(false);
    void voice.start();
  };
  const exitVoice = () => {
    voice.cancel();
    setMode("text");
    setDragProgress(0);
  };
  const onOverlayClick = () => {
    if (voice.status === "recording") {
      voice.stop(); // finish recording -> transcribe -> auto-send
      return;
    }
    if (voice.status === "transcribing") return; // busy; ignore taps
    exitVoice(); // idle or error -> dismiss
  };

  const onBlobPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    dragOrigin.current = e.clientX;
    setDragging(true);
  };
  const onBlobPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragOrigin.current === null) return;
    const delta = e.clientX - dragOrigin.current;
    setDragProgress(Math.min(Math.max(delta / DRAG_FULL, 0), 1));
  };
  const onBlobPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const delta = dragOrigin.current !== null ? e.clientX - dragOrigin.current : 0;
    dragOrigin.current = null;
    setDragging(false);
    if (Math.abs(delta) < 10) { enterVoice(); return; }
    if (dragProgress >= SNAP_THRESHOLD) { enterVoice(); } else { setDragProgress(0); }
  };

  const overlayRaw = dragging ? dragProgress : (mode === "voice" ? 1 : 0);
  const overlayEased = overlayRaw < 0.5
    ? 2 * overlayRaw * overlayRaw
    : 1 - Math.pow(-2 * overlayRaw + 2, 2) / 2;
  const textOpacity = dragging ? 1 - dragProgress : (mode === "voice" ? 0 : 1);

  const orbState: OrbState = voice.status === "transcribing" ? "thinking" : "listening";
  const barState = BAR_STATE[orbState ?? "idle"];
  const voiceHint =
    voice.status === "transcribing"
      ? "Transcribing…"
      : voice.status === "error"
        ? (voice.error ?? "Something went wrong.")
        : "Listening… tap to send";

  return (
    <ComposerPrimitive.Root
      data-empty={isEmpty}
      data-running={isRunning}
      className="group/composer relative mx-auto flex w-full max-w-3xl flex-col overflow-hidden rounded-4xl bg-white px-3 py-2 shadow-[0_2px_8px_-2px_rgba(0,0,0,0.16)] dark:bg-[#1e1f20] dark:shadow-[0_2px_8px_-2px_rgba(0,0,0,0.5)] transition-[min-height] duration-[380ms] ease-[cubic-bezier(0.16,1,0.3,1)]"
      style={{ minHeight: mode === "voice" ? 140 : undefined }}
    >
      {/* Voice overlay — expands from blob, shows Orb + BarVisualizer */}
      <div
        onClick={onOverlayClick}
        className="absolute inset-0 z-10 flex cursor-pointer flex-col items-center justify-center gap-2 rounded-4xl bg-white dark:bg-[#1e1f20]"
        style={{
          transform: `scale(${overlayEased})`,
          transformOrigin: "28px 50%",
          opacity: overlayEased,
          transition: dragging
            ? "none"
            : "transform 380ms cubic-bezier(0.16,1,0.3,1), opacity 260ms ease-out",
          pointerEvents: mode === "voice" ? "auto" : "none",
        }}
      >
        <Orb
          agentState={orbState}
          colors={ORB_COLORS}
          className="!h-20 !w-20"
        />
        <BarVisualizer
          state={barState}
          mediaStream={voice.stream}
          demo={voice.status === "transcribing"}
          barCount={16}
          minHeight={10}
          maxHeight={60}
          centerAlign={true}
          className="h-8 w-52 rounded-none p-0"
          style={{ background: "transparent" }}
        />
        <span
          className={`text-xs ${voice.status === "error" ? "text-red-500" : "text-[#70757a] dark:text-[#9aa0a6]"}`}
        >
          {voiceHint}
        </span>
      </div>

      {/* Attachments row */}
      <AuiIf condition={(s) => s.composer.attachments.length > 0}>
        <div className="overflow-hidden rounded-t-3xl">
          <div className="overflow-x-auto p-3.5">
            <div className="flex flex-row gap-3">
              <ComposerPrimitive.Attachments
                components={{ Attachment: GeminiAttachment }}
              />
            </div>
          </div>
        </div>
      </AuiIf>

      {/* Text mode content — fades out in sync with overlay reveal */}
      <div
        className="flex flex-col gap-3"
        style={{
          opacity: textOpacity,
          transition: dragging ? "none" : "opacity 200ms ease-out",
          pointerEvents: mode === "voice" ? "none" : "auto",
        }}
      >
        {/* Single compact row: blob | textarea | model picker | send */}
        <div className="flex items-center gap-2">
          <div
            onPointerDown={onBlobPointerDown}
            onPointerMove={onBlobPointerMove}
            onPointerUp={onBlobPointerUp}
            className="shrink-0 cursor-grab touch-none select-none"
          >
            <Orb
              agentState={null}
              colors={ORB_COLORS}
              className={`!h-[34px] !w-[34px] transition-transform duration-150 ${dragging ? "scale-110" : ""}`}
            />
          </div>
          <div className="wrap-break-word max-h-40 flex-1 overflow-y-auto">
            <ComposerPrimitive.Input
              placeholder="Ask Rahul"
              className="block min-h-6 w-full resize-none bg-transparent px-1 py-1 text-[#1f1f1f] outline-none placeholder:text-[#70757a] dark:text-[#e3e3e3] dark:placeholder:text-[#9aa0a6]"
            />
          </div>
          <div className="flex shrink-0 items-center gap-1 text-[#444746] dark:text-[#c4c7c5]">
            <GeminiModelPicker />
            <div className="relative size-8">
              <ComposerPrimitive.Send className="absolute inset-0 flex items-center justify-center rounded-full bg-[#d3e3fd] text-[#1f1f1f] transition-all duration-300 ease-out hover:bg-[#c2d7fb] group-data-[empty=true]/composer:scale-0 group-data-[running=true]/composer:scale-0 group-data-[empty=true]/composer:opacity-0 group-data-[running=true]/composer:opacity-0 dark:bg-[#1f3760] dark:text-[#e3e3e3] dark:hover:bg-[#2a4a7a]">
                <SendHorizonal width={16} height={16} />
              </ComposerPrimitive.Send>
              <ComposerPrimitive.Cancel className="absolute inset-0 flex items-center justify-center rounded-full bg-[#d3e3fd] text-[#1f1f1f] transition-all duration-300 ease-out hover:bg-[#c2d7fb] group-data-[running=false]/composer:scale-0 group-data-[running=false]/composer:opacity-0 dark:bg-[#1f3760] dark:text-[#e3e3e3] dark:hover:bg-[#2a4a7a]">
                <Square width={12} height={12} fill="currentColor" />
              </ComposerPrimitive.Cancel>
            </div>
          </div>
        </div>
      </div>
    </ComposerPrimitive.Root>
  );
};


const GEMINI_MODELS = [
  { id: "fast", name: "Fast", description: "Best for quick chats" },
  { id: "thinking", name: "Thinking", description: "Best for reasoning" },
  { id: "pro", name: "Pro", description: "Best for complex tasks" },
];

const GeminiModelPicker: FC = () => {
  const [model, setModel] = useState(GEMINI_MODELS[0]!.id);
  const current = GEMINI_MODELS.find((m) => m.id === model);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex h-10 items-center justify-center gap-1 whitespace-nowrap rounded-full px-3 text-sm transition hover:bg-[#444746]/8 dark:hover:bg-[#c4c7c5]/8">
        <span>{current?.name}</span>
        <ChevronDownIcon width={20} height={20} className="opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-60">
        {GEMINI_MODELS.map((m) => (
          <DropdownMenuItem
            key={m.id}
            onSelect={() => setModel(m.id)}
            className="flex items-start gap-3"
          >
            <span className="mt-0.5 flex size-4 items-center justify-center text-[#1a73e8] dark:text-[#8ab4f8]">
              {m.id === model ? <CheckIcon /> : null}
            </span>
            <span className="flex flex-1 flex-col">
              <span className="text-foreground text-sm">{m.name}</span>
              <span className="text-muted-foreground text-xs">
                {m.description}
              </span>
            </span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem className="text-muted-foreground text-sm">
          Upgrade to Gemini Advanced
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

const actionBtnClass =
  "flex size-8 items-center justify-center rounded-full text-[#444746] transition-colors hover:bg-[#444746]/8 dark:text-[#c4c7c5] dark:hover:bg-[#c4c7c5]/8";

// Reads a single reply aloud on demand, independent of the auto-speak toggle.
const SpeakMessageButton: FC = () => {
  const tts = useTts();
  const text = useAuiState((s) => {
    const parts = (s.message?.content ?? []) as Array<{ type: string; text?: string }>;
    return parts
      .filter((p) => p.type === "text")
      .map((p) => p.text ?? "")
      .join("");
  });
  if (!text) return null;
  return (
    <button
      type="button"
      className={actionBtnClass}
      aria-label="Play this reply"
      onClick={() => tts.speak(text, { force: true })}
    >
      <Volume2 width={14} height={14} />
    </button>
  );
};

const ChatMessage: FC = () => {
  return (
    <MessagePrimitive.Root className="group/message relative mx-auto mb-4 flex w-full max-w-3xl flex-col pb-0.5">
      <AuiIf condition={(s) => s.message.role === "user"}>
        <div className="flex items-center justify-end gap-1">
          <ActionBarPrimitive.Root className="flex items-center gap-0.5 pt-1 opacity-0 transition-opacity group-focus-within/message:opacity-100 group-hover/message:opacity-100">
            <ActionBarPrimitive.Copy className={actionBtnClass}>
              <CopyIcon width={16} height={16} />
            </ActionBarPrimitive.Copy>
            <ActionBarPrimitive.Edit className={actionBtnClass}>
              <Pencil1Icon width={16} height={16} />
            </ActionBarPrimitive.Edit>
          </ActionBarPrimitive.Root>
          <div className="max-w-[85%] rounded-3xl rounded-tr bg-[#e9eef6] px-4 py-3 text-[#1f1f1f] dark:bg-[#282a2c] dark:text-[#e3e3e3]">
            <div className="prose prose-sm dark:prose-invert wrap-break-word">
              <MessagePrimitive.Parts components={{ Text: MarkdownText }} />
            </div>
          </div>
        </div>
      </AuiIf>

      <AuiIf condition={(s) => s.message.role === "assistant"}>
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-[#e9eef6] dark:bg-[#282a2c]">
            <ZapIcon className="size-4 text-[#1f1f1f] dark:text-[#e3e3e3]" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="prose prose-sm dark:prose-invert wrap-break-word prose-li:my-1 prose-ol:my-1 prose-p:my-2 prose-ul:my-1 text-[#1f1f1f] dark:text-[#e3e3e3]">
              <MessagePrimitive.Parts components={{ Text: MarkdownText }} />
            </div>
            <ActionBarPrimitive.Root className="mt-2 -ml-2 flex items-center gap-0.5 opacity-0 transition-opacity duration-300 group-focus-within/message:opacity-100 group-hover/message:opacity-100">
              <ActionBarPrimitive.FeedbackPositive className={actionBtnClass}>
                <ThumbsUp width={14} height={14} />
              </ActionBarPrimitive.FeedbackPositive>
              <ActionBarPrimitive.FeedbackNegative className={actionBtnClass}>
                <ThumbsDown width={14} height={14} />
              </ActionBarPrimitive.FeedbackNegative>
              <ActionBarPrimitive.Reload className={actionBtnClass}>
                <ReloadIcon width={14} height={14} />
              </ActionBarPrimitive.Reload>
              <ActionBarPrimitive.Copy className={actionBtnClass}>
                <CopyIcon width={14} height={14} />
              </ActionBarPrimitive.Copy>
              <SpeakMessageButton />
              <button type="button" className={actionBtnClass}>
                <EllipsisVertical width={14} height={14} />
              </button>
            </ActionBarPrimitive.Root>
          </div>
        </div>
      </AuiIf>
    </MessagePrimitive.Root>
  );
};

const useFileSrc = (file: File | undefined) => {
  const [src, setSrc] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!file) {
      setSrc(undefined);
      return;
    }

    const objectUrl = URL.createObjectURL(file);
    setSrc(objectUrl);

    return () => {
      URL.revokeObjectURL(objectUrl);
    };
  }, [file]);

  return src;
};

const useAttachmentSrc = () => {
  const { file, src } = useAuiState(
    useShallow(({ attachment }): { file?: File; src?: string } => {
      if (attachment.type !== "image") return {};
      if (attachment.file) return { file: attachment.file };
      const src = attachment.content?.filter((c) => c.type === "image")[0]
        ?.image;
      if (!src) return {};
      return { src };
    }),
  );

  return useFileSrc(file) ?? src;
};

const GeminiAttachment: FC = () => {
  const isImage = useAuiState(({ attachment }) => attachment.type === "image");
  const src = useAttachmentSrc();

  return (
    <AttachmentPrimitive.Root className="group/thumbnail relative">
      <div
        className="overflow-hidden rounded-lg border border-[#dadce0] shadow-sm hover:border-[#c4c7c5] hover:shadow-md dark:border-[#3c4043] dark:hover:border-[#5f6368]"
        style={{
          width: "120px",
          height: "120px",
          minWidth: "120px",
          minHeight: "120px",
        }}
      >
        <button
          type="button"
          className="relative"
          style={{ width: "120px", height: "120px" }}
        >
          {isImage && src ? (
            // biome-ignore lint/performance/noImgElement: attachment preview
            <img
              className="h-full w-full object-cover transition duration-400"
              alt="Attachment"
              src={src}
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-[#70757a] dark:text-[#9aa0a6]">
              <AttachmentPrimitive.unstable_Thumb className="text-xs" />
            </div>
          )}
        </button>
      </div>
      <AttachmentPrimitive.Remove
        className="absolute -top-2 -right-2 flex size-8 items-center justify-center rounded-full border border-[#dadce0] bg-white text-[#70757a] opacity-0 backdrop-blur-sm transition-all hover:bg-[#f1f3f4] hover:text-[#1f1f1f] group-focus-within/thumbnail:opacity-100 group-hover/thumbnail:opacity-100 dark:border-[#3c4043] dark:bg-[#1e1f20] dark:text-[#9aa0a6] dark:hover:bg-[#2b2c2f] dark:hover:text-[#e3e3e3]"
        aria-label="Remove attachment"
      >
        <Cross2Icon width={16} height={16} />
      </AttachmentPrimitive.Remove>
    </AttachmentPrimitive.Root>
  );
};
