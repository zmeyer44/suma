/**
 * The AI chat sidebar (⌘I, or the spark button in the tab strip).
 *
 * It is a flex sibling of the content hole rather than an overlay, which is
 * what makes it behave: opening it narrows the hole, ContentPanes reports the
 * new bounds, and main resizes the tab WebContentsViews to match (§8.1). The
 * page is pushed aside, never covered — and because the sidebar's column is
 * outside the hole, no tab view sits above it and its controls stay clickable
 * even though the chrome renders BELOW the tab views.
 *
 * The conversation is built from the shadcn chat components (ui/message,
 * ui/bubble, ui/marker, ui/message-scroller) and driven by `useChat` from
 * @ai-sdk/react. Everything the hook exposes is wired: streaming text,
 * reasoning and tool parts, stop, regenerate, and errors. What is NOT here is
 * a model — see lib/chat.ts for the transport split between a configured
 * endpoint and the local stub.
 */

import { useChat } from "@ai-sdk/react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { getToolName, isToolUIPart, type UIMessage } from "ai";
import {
  ArrowUp,
  Brain,
  FileText,
  Link2,
  Link2Off,
  LoaderCircle,
  Maximize2,
  Paperclip,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Settings2,
  Sparkles,
  Square,
  TextQuote,
  Volume2,
  Wrench,
  X,
} from "lucide-react";
import type { ChatSettingsInfo } from "../../../shared/chat";
import {
  CHAT_DEFAULT_WIDTH,
  CHAT_MAX_WIDTH,
  CHAT_MIN_WIDTH,
  createChatTransport,
  formatChatAttachment,
  formatFileAttachmentText,
  getChatEndpoint,
  MAX_FILE_ATTACHMENTS,
  readFileAttachment,
  type ChatFileAttachment,
  type ChatPageContext,
} from "../lib/chat";
import { speechTitle } from "../../../shared/tts";
import { selectIsCurrent, speakText, useAudioStore } from "../lib/audio";
import { cn } from "../lib/cn";
import { hostOf } from "../lib/url";
import { selectActiveTab, useSumaStore } from "../store";
import { Button } from "./ui/button";
import { Bubble, BubbleContent } from "./ui/bubble";
import { Markdown } from "./ui/markdown";
import { Marker, MarkerContent, MarkerIcon } from "./ui/marker";
import {
  Message,
  MessageAvatar,
  MessageContent,
  MessageFooter,
  MessageHeader,
} from "./ui/message";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "./ui/message-scroller";
import { Textarea } from "./ui/textarea";

/** Slide durations, in ms. These MUST match `.chat-slide` in styles.css: the
 *  close timer below is what unmounts the panel when the slide-out lands. */
const OPEN_MS = 220;
const CLOSE_MS = 160;

const SUGGESTIONS = [
  "Summarize this page",
  "What does this page look like?",
  "Find the pricing page on this site",
];

/** Keyboard resize step (←/→ on the focused handle), in px. */
const KEY_STEP = 24;
/** Hit area around the 2px rule — the same forgiving seam the divider has. */
const HANDLE_W = 7;

/**
 * The sidebar's resize handle, built on exactly the mechanism the split-view
 * divider uses (§6, ContentPanes).
 *
 * The load-bearing part is `setPaneResizing`: a drag leaving the sidebar
 * crosses over the tab WebContentsViews, which sit ABOVE the chrome and would
 * swallow every pointermove — the drag would stall the moment the pointer
 * reached the page. Setting the flag feeds the same overlay mechanism modals
 * use, so main raises the chrome view for the duration and the moves keep
 * landing on this document. Releasing lowers it again (tabs.syncVisibility).
 *
 * Width streams out per frame; ContentPanes re-measures the narrowed hole and
 * main tracks the tab views to it, so the page resizes under the handle
 * rather than after it.
 */
function ResizeHandle({ width }: { width: number }) {
  const setChatWidth = useSumaStore((s) => s.setChatWidth);
  const setPaneResizing = useSumaStore((s) => s.setPaneResizing);
  const resizing = useSumaStore((s) => s.paneResizing);

  const onPointerDown = (e: React.PointerEvent): void => {
    if (e.button !== 0) return;
    e.preventDefault();
    setPaneResizing(true);
    let raf = 0;
    let pendingX = e.clientX;
    const apply = (): void => {
      raf = 0;
      // The sidebar is flush with the window's right edge, so its width is
      // whatever remains to the right of the pointer.
      setChatWidth(window.innerWidth - pendingX);
    };
    const onMove = (ev: PointerEvent): void => {
      pendingX = ev.clientX;
      if (raf === 0) raf = requestAnimationFrame(apply);
    };
    const onUp = (): void => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (raf !== 0) cancelAnimationFrame(raf);
      setPaneResizing(false);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    // The arrow moves the SEPARATOR: left widens the sidebar behind it.
    setChatWidth(width + (e.key === "ArrowLeft" ? KEY_STEP : -KEY_STEP));
  };

  return (
    <>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize chat sidebar"
        aria-valuenow={width}
        aria-valuemin={CHAT_MIN_WIDTH}
        aria-valuemax={CHAT_MAX_WIDTH}
        tabIndex={0}
        title="Drag to resize — double-click to reset"
        style={{ width: HANDLE_W, left: -Math.round(HANDLE_W / 2) }}
        onPointerDown={onPointerDown}
        onDoubleClick={() => setChatWidth(CHAT_DEFAULT_WIDTH)}
        onKeyDown={onKeyDown}
        className="group absolute inset-y-0 z-10 cursor-col-resize outline-none"
      >
        <div
          className={cn(
            "mx-auto h-full w-[2px] rounded-full transition-colors",
            resizing
              ? "bg-accent/60"
              : "bg-transparent group-hover:bg-ink/25 group-focus-visible:bg-accent/50",
          )}
        />
      </div>
      {/* While dragging, the pointer roams the whole raised chrome — keep the
          resize cursor everywhere instead of flickering per element. */}
      {resizing ? <div className="fixed inset-0 z-50 cursor-col-resize" /> : null}
    </>
  );
}

/** What the tool markers say, per browser tool (main/chat/chat-tools.ts). */
const TOOL_LABELS: Record<string, { running: string; done: string }> = {
  list_tabs: { running: "Checking the open tabs…", done: "Checked the open tabs" },
  open_tab: { running: "Opening a tab…", done: "Opened a tab" },
  select_tab: { running: "Switching tabs…", done: "Switched tabs" },
  navigate: { running: "Navigating…", done: "Navigated" },
  read_page: { running: "Reading the page…", done: "Read the page" },
  screenshot: { running: "Taking a screenshot…", done: "Took a screenshot" },
  click: { running: "Clicking…", done: "Clicked on the page" },
  type_text: { running: "Typing…", done: "Typed on the page" },
  press_key: { running: "Pressing a key…", done: "Pressed a key" },
  scroll: { running: "Scrolling…", done: "Scrolled the page" },
};

/**
 * An image in the transcript — a screenshot the assistant took, or an image
 * the user dropped in. Sized by its own aspect ratio (max-w AND max-h caps,
 * never a forced box) so the border hugs the pixels; hovering reveals the
 * expand button that opens it in the chrome lightbox (ImagePreviewModal).
 * Its own group name, so the bubble's `group/bubble` hover cannot reveal
 * the button from a distance.
 */
function ChatImage({ src, alt }: { src: string; alt: string }) {
  const setChatImagePreview = useSumaStore((s) => s.setChatImagePreview);
  return (
    <span className="group/shot relative my-1 block w-fit max-w-full">
      <img
        src={src}
        alt={alt}
        className="block h-auto max-h-48 w-auto max-w-full rounded-lg border border-hairline"
      />
      <button
        type="button"
        title="Expand image"
        aria-label="Expand image"
        onClick={() => setChatImagePreview({ src, alt })}
        className="absolute top-1.5 right-1.5 grid size-6 cursor-pointer place-items-center rounded-md bg-black/50 text-white opacity-0 transition-opacity group-hover/shot:opacity-100 focus-visible:opacity-100 hover:bg-black/65"
      >
        <Maximize2 className="size-3" aria-hidden="true" />
      </button>
    </span>
  );
}

/** The screenshot tool's output, when it looks like one (untyped over IPC). */
function screenshotFrom(output: unknown): { src: string; alt: string } | null {
  if (typeof output !== "object" || output === null) return null;
  const record = output as Record<string, unknown>;
  if (typeof record["data"] !== "string" || typeof record["mediaType"] !== "string") {
    return null;
  }
  return {
    src: `data:${record["mediaType"]};base64,${record["data"]}`,
    alt: typeof record["title"] === "string" ? record["title"] : "Screenshot",
  };
}

/** One rendered message part. Unknown part types are skipped, not guessed at. */
function MessagePart({
  part,
  isUser,
}: {
  part: UIMessage["parts"][number];
  isUser: boolean;
}) {
  const createTab = useSumaStore((s) => s.createTab);
  if (part.type === "text") {
    // The user's own words stay verbatim; the assistant's are markdown —
    // links in a reply open as tabs, never by navigating the chrome.
    return isUser ? (
      <BubbleContent className="whitespace-pre-wrap">{part.text}</BubbleContent>
    ) : (
      <BubbleContent>
        <Markdown onLinkClick={(url) => void createTab(url)}>{part.text}</Markdown>
      </BubbleContent>
    );
  }
  if (part.type === "reasoning") {
    return (
      <Marker className="px-1">
        <MarkerIcon>
          <Brain className="size-3" aria-hidden="true" />
        </MarkerIcon>
        <MarkerContent className="italic">{part.text}</MarkerContent>
      </Marker>
    );
  }
  // Attached files (drag-and-drop): images render like screenshots — same
  // aspect-ratio sizing, same expand button — the rest show as a named chip.
  if (part.type === "file") {
    if (part.mediaType.startsWith("image/")) {
      return <ChatImage src={part.url} alt={part.filename ?? "Attached image"} />;
    }
    return (
      <span className="my-1 inline-flex max-w-full items-center gap-1.5 rounded-lg border border-hairline bg-ink/4 px-2 py-1 text-[11px]">
        <FileText className="size-3 shrink-0 text-muted" aria-hidden="true" />
        <span className="truncate">{part.filename ?? part.mediaType}</span>
      </span>
    );
  }
  // Tool traffic: `tool-<name>` for typed tools, `dynamic-tool` for the rest.
  // The SDK's guard covers both and is what narrows the part union.
  if (isToolUIPart(part)) {
    const name = getToolName(part);
    const labels = TOOL_LABELS[name];
    const failed = part.state === "output-error";
    const running = part.state !== "output-available" && !failed;
    const shot =
      name === "screenshot" && part.state === "output-available"
        ? screenshotFrom(part.output)
        : null;
    return (
      <>
        <Marker className={cn("px-1", failed && "text-danger")}>
          <MarkerIcon>
            <Wrench className="size-3" aria-hidden="true" />
          </MarkerIcon>
          <MarkerContent className={running ? "animate-pulse-dot" : ""}>
            {failed
              ? `${labels?.running.replace(/…$/, "") ?? name} failed — ${part.errorText ?? "unknown error"}`
              : running
                ? (labels?.running ?? `Running ${name}…`)
                : (labels?.done ?? `Used ${name}`)}
          </MarkerContent>
        </Marker>
        {/* The screenshot the model saw, so the user sees it too. */}
        {shot !== null ? <ChatImage src={shot.src} alt={shot.alt} /> : null}
      </>
    );
  }
  return null;
}

/** The spoken half of a turn: its prose, without tool traffic or reasoning. */
function spokenText(message: UIMessage): string {
  return message.parts
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n\n")
    .trim();
}

/**
 * Read this answer aloud — the initial reason the app has a player at all.
 *
 * It hands the message id to the player, which is what makes the button a
 * toggle: pressing it again pauses rather than synthesizing the same answer
 * twice. And because the player is app-level, the reading survives closing this
 * sidebar, switching tabs, or navigating away mid-sentence (lib/audio.ts).
 */
function ReadAloudButton({ message }: { message: UIMessage }) {
  const text = spokenText(message);
  const isCurrent = useAudioStore((s) => selectIsCurrent(s, message.id));
  const status = useAudioStore((s) => s.status);
  if (text === "") return null;

  const label = !isCurrent
    ? "Read aloud"
    : status === "preparing"
      ? "Generating…"
      : status === "playing"
        ? "Pause"
        : "Resume";

  // The glyph carries the state the label used to spell out; the label itself
  // moves to title/aria-label so the meaning survives for screen readers and
  // on hover.
  const Icon = !isCurrent
    ? Volume2
    : status === "preparing"
      ? LoaderCircle
      : status === "playing"
        ? Pause
        : Play;

  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={isCurrent && status === "preparing"}
      onClick={() =>
        speakText({
          id: message.id,
          title: speechTitle(text),
          origin: "Assistant",
          source: { kind: "tts", text },
        })
      }
      className={cn(
        "flex cursor-pointer items-center rounded p-1 transition-colors hover:bg-ink/8 hover:text-text disabled:cursor-default",
        isCurrent && "text-accent",
      )}
    >
      <Icon
        className={cn("size-3", status === "preparing" && isCurrent && "animate-spin")}
        aria-hidden="true"
      />
    </button>
  );
}

function ChatMessage({
  message,
  onRegenerate,
  /** Suppressed while the turn is still streaming — half an answer is not one. */
  canSpeak = false,
}: {
  message: UIMessage;
  /** Present only on the last settled assistant turn. */
  onRegenerate?: () => void;
  canSpeak?: boolean;
}) {
  const isUser = message.role === "user";
  const showFooter = onRegenerate !== undefined || canSpeak;
  return (
    <Message align={isUser ? "end" : "start"}>
      {isUser ? null : (
        <MessageAvatar>
          <Sparkles className="size-3 text-accent" aria-hidden="true" />
        </MessageAvatar>
      )}
      {/* Header, bubbles, and footer all live in the content column — putting
          the footer outside it would left-align "Regenerate" under the avatar
          and strand the avatar below the bubble's baseline. */}
      <MessageContent>
        {isUser ? null : <MessageHeader>Assistant</MessageHeader>}
        <Bubble variant={isUser ? "default" : "muted"} align={isUser ? "end" : "start"}>
          {message.parts.map((part, i) => (
            <MessagePart key={`${message.id}-${i}`} part={part} isUser={isUser} />
          ))}
        </Bubble>
        {showFooter ? (
          <MessageFooter>
            {canSpeak ? <ReadAloudButton message={message} /> : null}
            {onRegenerate === undefined ? null : (
              <button
                type="button"
                title="Regenerate"
                aria-label="Regenerate"
                onClick={onRegenerate}
                className="flex cursor-pointer items-center rounded p-1 transition-colors hover:bg-ink/8 hover:text-text"
              >
                <RotateCcw className="size-3" aria-hidden="true" />
              </button>
            )}
          </MessageFooter>
        ) : null}
      </MessageContent>
    </Message>
  );
}

export function ChatSidebar() {
  const open = useSumaStore((s) => s.chatOpen);
  const width = useSumaStore((s) => s.chatWidth);
  const setChatOpen = useSumaStore((s) => s.setChatOpen);
  const activeTab = useSumaStore(selectActiveTab);
  const attachments = useSumaStore((s) => s.chatAttachments);
  const removeChatAttachment = useSumaStore((s) => s.removeChatAttachment);
  const clearChatAttachments = useSumaStore((s) => s.clearChatAttachments);
  const pushToast = useSumaStore((s) => s.pushToast);

  // Files dropped onto the sidebar, staged for the next message. Local state
  // (unlike the selection attachments) because drops land on this component
  // and nowhere else. `dragDepth` counts enter/leave pairs — dragging across
  // the sidebar's children fires leave/enter per element, and a plain
  // boolean would flicker the overlay off at every boundary.
  const [fileAttachments, setFileAttachments] = useState<ChatFileAttachment[]>([]);
  const [dragDepth, setDragDepth] = useState(0);

  const [input, setInput] = useState("");
  const [useContext, setUseContext] = useState(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // The composer grows with its content: one line empty, taller as the
  // message wraps, clamped by its max-h (past that it scrolls). Measured
  // from scrollHeight in a layout effect so the height lands before paint —
  // and re-measured on sidebar resize, since width changes the wrapping.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (el === null) return;
    el.style.height = "auto";
    el.style.height = `${String(el.scrollHeight)}px`;
  }, [input, width]);

  // Read at send time so the transport always attaches the CURRENT tab; the
  // ref keeps the transport itself stable across tab switches.
  const contextRef = useRef<ChatPageContext | null>(null);
  contextRef.current =
    useContext && activeTab !== null ? { url: activeTab.url, title: activeTab.title } : null;

  const transport = useMemo(() => createChatTransport(() => contextRef.current), []);
  const endpointConfigured = useMemo(() => getChatEndpoint() !== null, []);

  // The assistant's configuration (model, key presence) — re-read every time
  // the sidebar opens, so adding a key in settings lights it up immediately.
  const openSettings = useSumaStore((s) => s.openSettings);
  const [chatConfig, setChatConfig] = useState<ChatSettingsInfo | null>(null);
  useEffect(() => {
    if (!open) return;
    let live = true;
    void window.suma
      ?.invoke("chat:settings", undefined)
      .then((info) => {
        if (live) setChatConfig(info);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [open]);
  const needsKey = !endpointConfigured && chatConfig?.keyState === "unset";

  const { messages, sendMessage, status, stop, regenerate, error, clearError, setMessages } =
    useChat({ transport });

  const busy = status === "submitted" || status === "streaming";

  // The panel outlives `open` by one animation: it mounts collapsed and
  // expands on the next frame, and on close it collapses first and unmounts
  // when the slide is done. `animating` gates the width transition so a resize
  // drag — which is not an open/close — still tracks the pointer exactly.
  // (Only the <aside> comes and goes; this component stays mounted either way,
  // so the conversation survives a close.)
  const [mounted, setMounted] = useState(open);
  const [expanded, setExpanded] = useState(open);
  const [animating, setAnimating] = useState(false);
  const firstRun = useRef(true);

  useEffect(() => {
    // A session that starts with the sidebar open shows it; it does not play
    // an opening animation at launch.
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }

    if (open) {
      setMounted(true);
      setAnimating(true);
      // Two frames: the collapsed width has to be painted before the expanded
      // one is set, or the browser coalesces both into one style change and
      // there is nothing to transition from.
      let inner = 0;
      const outer = requestAnimationFrame(() => {
        inner = requestAnimationFrame(() => setExpanded(true));
      });
      const settle = window.setTimeout(() => setAnimating(false), OPEN_MS + 60);
      return () => {
        cancelAnimationFrame(outer);
        cancelAnimationFrame(inner);
        window.clearTimeout(settle);
      };
    }

    setAnimating(true);
    setExpanded(false);
    const settle = window.setTimeout(() => {
      setMounted(false);
      setAnimating(false);
    }, CLOSE_MS);
    return () => window.clearTimeout(settle);
  }, [open]);

  useEffect(() => {
    // preventScroll: the panel is clipped while it slides in, and a focus
    // scroll would shove it sideways inside its own clip box.
    if (open && mounted) inputRef.current?.focus({ preventScroll: true });
  }, [open, mounted]);

  // "Add to chat" lands here from the page toolbar: the sidebar may already
  // be open, so the open-effect above will not fire — the question the user
  // is about to type belongs in the composer either way.
  useEffect(() => {
    if (attachments.length > 0) inputRef.current?.focus({ preventScroll: true });
  }, [attachments.length]);

  if (!mounted) return null;

  const submit = (text: string): void => {
    const value = text.trim();
    // An attachment alone is a sendable message — "what about this?" implied.
    if (
      (value.length === 0 && attachments.length === 0 && fileAttachments.length === 0) ||
      busy
    ) {
      return;
    }
    // Text files fold into the message body; images and PDFs travel as file
    // parts so the model actually sees them (lib/chat.ts).
    const textBlocks = fileAttachments
      .filter((f) => f.kind === "text")
      .map((f) => formatFileAttachmentText(f.name, f.text ?? ""));
    const parts = [
      ...attachments.map(formatChatAttachment),
      ...textBlocks,
      value,
    ].filter((part) => part.length > 0);
    const files = fileAttachments
      .filter((f) => f.kind !== "text")
      .map((f) => ({
        type: "file" as const,
        mediaType: f.mediaType,
        filename: f.name,
        url: f.url,
      }));
    const message = parts.join("\n\n");
    if (files.length > 0 && message.length > 0) {
      void sendMessage({ text: message, files });
    } else if (files.length > 0) {
      void sendMessage({ files });
    } else {
      void sendMessage({ text: message });
    }
    setInput("");
    if (attachments.length > 0) clearChatAttachments();
    if (fileAttachments.length > 0) setFileAttachments([]);
  };

  /* ------------------------- drag-and-drop uploads ------------------------ */

  const addDroppedFiles = async (list: FileList): Promise<void> => {
    const dropped = Array.from(list);
    const room = MAX_FILE_ATTACHMENTS - fileAttachments.length;
    if (room <= 0) {
      pushToast(
        `At most ${String(MAX_FILE_ATTACHMENTS)} files per message`,
        "warning",
      );
      return;
    }
    if (dropped.length > room) {
      pushToast(
        `Attached the first ${String(room)} — at most ${String(MAX_FILE_ATTACHMENTS)} files per message`,
        "warning",
      );
    }
    for (const file of dropped.slice(0, room)) {
      try {
        const result = await readFileAttachment(file);
        if (result.ok) {
          setFileAttachments((prev) => [...prev, result.attachment]);
        } else {
          pushToast(result.reason, "warning");
        }
      } catch {
        pushToast(`Could not read ${file.name}`, "error");
      }
    }
    inputRef.current?.focus({ preventScroll: true });
  };

  const hasFilePayload = (e: React.DragEvent): boolean =>
    e.dataTransfer.types.includes("Files");

  const dragHandlers = {
    onDragEnter: (e: React.DragEvent) => {
      if (!hasFilePayload(e)) return;
      e.preventDefault();
      setDragDepth((d) => d + 1);
    },
    onDragOver: (e: React.DragEvent) => {
      if (!hasFilePayload(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!hasFilePayload(e)) return;
      setDragDepth((d) => Math.max(0, d - 1));
    },
    onDrop: (e: React.DragEvent) => {
      if (!hasFilePayload(e)) return;
      e.preventDefault();
      setDragDepth(0);
      void addDroppedFiles(e.dataTransfer.files);
    },
  };

  return (
    <aside
      aria-label="AI chat"
      // On its way out it should take no clicks and no tab stops.
      inert={open ? undefined : true}
      data-closing={open ? undefined : ""}
      // The store clamps every width it stores, so this needs no min/max of
      // its own — and a min would pin the collapsed end of the slide open.
      style={{ width: expanded ? width : 0 }}
      className={cn("no-drag relative h-full shrink-0", animating && "chat-slide")}
    >
      <ResizeHandle width={width} />

      {/* The clip box takes the animating width; the panel inside keeps its
          full width the whole way, so it slides in as one piece rather than
          reflowing at every intermediate width. The border and fill live on
          the panel, not the clip box, so the sidebar's own left edge travels
          with it instead of standing still at the window edge. */}
      <div className="h-full w-full overflow-hidden">
        <div
          style={{ width }}
          {...dragHandlers}
          className="relative flex h-full flex-col border-l border-chrome-edge bg-chrome"
        >
          {/* Drop target feedback — pointer-events-none so the drop still
              lands on the panel underneath, not on this veil. */}
          {dragDepth > 0 ? (
            <div className="pointer-events-none absolute inset-2 z-20 grid place-items-center rounded-xl border-2 border-dashed border-accent/60 bg-accent/8">
              <span className="flex items-center gap-1.5 rounded-full bg-chrome px-3 py-1.5 text-[12px] font-medium text-accent shadow-md">
                <Paperclip className="size-3.5" aria-hidden="true" />
                Drop files to attach
              </span>
            </div>
          ) : null}
          <header className="flex h-9 shrink-0 items-center gap-1.5 border-b border-hairline px-2.5">
            <Sparkles className="size-3 text-accent" aria-hidden="true" />
            <span className="text-[12px] font-medium text-text">Assistant</span>
            <span className="ml-auto flex items-center gap-0.5">
              <Button
                variant="ghost"
                size="icon"
                title="Assistant settings"
                aria-label="Assistant settings"
                onClick={() => void openSettings("assistant")}
              >
                <Settings2 className="size-3" aria-hidden="true" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                title="New chat"
                aria-label="New chat"
                disabled={messages.length === 0 || busy}
                onClick={() => setMessages([])}
              >
                <Plus className="size-3" aria-hidden="true" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                title="Close chat (⌘I)"
                aria-label="Close chat"
                onClick={() => setChatOpen(false)}
              >
                <X className="size-3" aria-hidden="true" />
              </Button>
            </span>
          </header>
    
          <div className="min-h-0 flex-1">
            <MessageScrollerProvider>
              <MessageScroller>
                <MessageScrollerViewport aria-label="Conversation">
                  <MessageScrollerContent className="px-2.5 py-3">
                    {needsKey ? (
                      <Marker variant="separator">
                        <MarkerContent>
                          No AI Gateway key —{" "}
                          <button
                            type="button"
                            onClick={() => void openSettings("assistant")}
                            className="cursor-pointer underline underline-offset-2 hover:text-text"
                          >
                            add one in Settings
                          </button>{" "}
                          to talk to a model
                        </MarkerContent>
                      </Marker>
                    ) : null}
    
                    {messages.length === 0 ? (
                      <div className="my-auto flex flex-col items-center gap-2 py-6 text-center">
                        <Sparkles className="size-5 text-ink/25" aria-hidden="true" />
                        <p className="text-[12px] text-muted">
                          Ask about this page — or have the assistant browse for you
                        </p>
                        <div className="mt-1 flex w-full flex-col gap-1.5">
                          {SUGGESTIONS.map((s) => (
                            <button
                              key={s}
                              type="button"
                              onClick={() => submit(s)}
                              className="cursor-pointer rounded-lg border border-hairline bg-ink/4 px-2.5 py-1.5 text-left text-[11.5px] text-muted transition-colors hover:border-ink/20 hover:bg-ink/8 hover:text-text"
                            >
                              {s}
                            </button>
                          ))}
                        </div>
                      </div>
                    ) : null}
    
                    {messages.map((message, i) => (
                      <MessageScrollerItem
                        key={message.id}
                        messageId={message.id}
                        // Anchor on the newest turn so a streaming reply grows
                        // downward from a fixed point instead of jittering.
                        scrollAnchor={i === messages.length - 1}
                      >
                        <ChatMessage
                          message={message}
                          onRegenerate={
                            message.role === "assistant" && i === messages.length - 1 && !busy
                              ? () => void regenerate()
                              : undefined
                          }
                          canSpeak={
                            message.role === "assistant" &&
                            !(i === messages.length - 1 && busy)
                          }
                        />
                      </MessageScrollerItem>
                    ))}
    
                    {status === "submitted" ? (
                      <Marker className="px-1">
                        <MarkerIcon>
                          <span className="size-1.5 animate-pulse-dot rounded-full bg-accent" />
                        </MarkerIcon>
                        <MarkerContent>Thinking…</MarkerContent>
                      </Marker>
                    ) : null}
    
                    {error !== undefined ? (
                      <Marker className="text-danger">
                        <MarkerContent>{error.message || "The request failed"}</MarkerContent>
                        <span className="ml-auto flex shrink-0 items-center gap-1">
                          <button
                            type="button"
                            onClick={() => {
                              clearError();
                              void regenerate();
                            }}
                            className="cursor-pointer rounded px-1 py-0.5 hover:bg-ink/8"
                          >
                            Retry
                          </button>
                          <button
                            type="button"
                            onClick={clearError}
                            className="cursor-pointer rounded px-1 py-0.5 hover:bg-ink/8"
                          >
                            Dismiss
                          </button>
                        </span>
                      </Marker>
                    ) : null}
                  </MessageScrollerContent>
                </MessageScrollerViewport>
                <MessageScrollerButton direction="end" />
              </MessageScroller>
            </MessageScrollerProvider>
          </div>
    
          <form
            className="shrink-0 border-t border-hairline p-2"
            onSubmit={(e) => {
              e.preventDefault();
              submit(input);
            }}
          >
            {attachments.length > 0 ? (
              <div className="mb-1.5 flex flex-col gap-1">
                {attachments.map((a) => (
                  <div
                    key={a.id}
                    className="flex items-center gap-1 rounded-md bg-accent/12 px-1.5 py-1 text-[10.5px] text-accent"
                  >
                    <TextQuote className="size-2.5 shrink-0" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate" title={a.text}>
                      {a.text}
                    </span>
                    <span className="shrink-0 text-accent/70">{hostOf(a.url)}</span>
                    <button
                      type="button"
                      title="Remove from message"
                      aria-label="Remove attachment"
                      onClick={() => removeChatAttachment(a.id)}
                      className="shrink-0 cursor-pointer rounded p-0.5 transition-colors hover:bg-accent/20"
                    >
                      <X className="size-2.5" aria-hidden="true" />
                    </button>
                  </div>
                ))}
              </div>
            ) : null}

            {fileAttachments.length > 0 ? (
              <div className="mb-1.5 flex flex-wrap items-end gap-1.5">
                {fileAttachments.map((f) => (
                  <span key={f.id} className="group/chip relative">
                    {f.kind === "image" ? (
                      <img
                        src={f.url}
                        alt={f.name}
                        title={f.name}
                        className="block h-12 w-auto max-w-24 rounded-md border border-hairline object-cover"
                      />
                    ) : (
                      <span
                        title={f.name}
                        className="flex h-8 max-w-40 items-center gap-1 rounded-md border border-hairline bg-ink/4 px-1.5 text-[10.5px] text-muted"
                      >
                        <FileText className="size-3 shrink-0" aria-hidden="true" />
                        <span className="truncate">{f.name}</span>
                      </span>
                    )}
                    <button
                      type="button"
                      title="Remove file"
                      aria-label={`Remove ${f.name}`}
                      onClick={() =>
                        setFileAttachments((prev) => prev.filter((x) => x.id !== f.id))
                      }
                      className="absolute -top-1.5 -right-1.5 grid size-4 cursor-pointer place-items-center rounded-full bg-ink/70 text-bg opacity-0 shadow transition-opacity group-hover/chip:opacity-100 focus-visible:opacity-100 hover:bg-ink"
                    >
                      <X className="size-2.5" aria-hidden="true" />
                    </button>
                  </span>
                ))}
              </div>
            ) : null}

            {activeTab !== null ? (
              <button
                type="button"
                onClick={() => setUseContext((v) => !v)}
                title={
                  useContext
                    ? "This page is sent with your message — click to detach"
                    : "Click to send this page as context"
                }
                className={cn(
                  "mb-1.5 flex max-w-full cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 text-[10.5px] transition-colors",
                  useContext
                    ? "bg-accent/12 text-accent hover:bg-accent/20"
                    : "text-faint hover:bg-ink/8 hover:text-muted",
                )}
              >
                {useContext ? (
                  <Link2 className="size-2.5 shrink-0" aria-hidden="true" />
                ) : (
                  <Link2Off className="size-2.5 shrink-0" aria-hidden="true" />
                )}
                <span className="truncate">
                  {useContext ? hostOf(activeTab.url) || "this page" : "Page not attached"}
                </span>
              </button>
            ) : null}
    
            <div className="flex items-end gap-1.5 rounded-xl border border-hairline bg-bg/60 px-2 py-1.5 focus-within:border-accent/60 focus-within:ring-2 focus-within:ring-accent/20">
              <Textarea
                variant="bare"
                ref={inputRef}
                rows={1}
                value={input}
                placeholder="Ask anything…"
                aria-label="Message"
                spellCheck={false}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  // Chords belong to the window (⌘I to close, ⌘T, ⌘L, …): the
                  // composer autofocuses, so swallowing them here would disable
                  // every app shortcut for as long as the sidebar is open.
                  if (e.metaKey || e.ctrlKey || e.altKey) return;
                  e.stopPropagation();
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    submit(input);
                  }
                }}
                className="max-h-32 flex-1 resize-none overflow-y-auto py-0.5 text-[12.5px]"
              />
              {busy ? (
                <Button variant="secondary" size="icon" title="Stop" aria-label="Stop" onClick={stop}>
                  <Square className="size-2.5" fill="currentColor" aria-hidden="true" />
                </Button>
              ) : (
                <Button
                  type="submit"
                  size="icon"
                  title="Send (↵)"
                  aria-label="Send"
                  disabled={
                    input.trim().length === 0 &&
                    attachments.length === 0 &&
                    fileAttachments.length === 0
                  }
                >
                  <ArrowUp className="size-3" strokeWidth={2.5} aria-hidden="true" />
                </Button>
              )}
            </div>
          </form>
        </div>
      </div>
    </aside>
  );
}
