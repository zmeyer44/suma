/**
 * The chat sidebar's AI SDK wiring (ai v7 / @ai-sdk/react).
 *
 * Three transports, in order of preference:
 *
 *  - A configured endpoint (`suma:chatEndpoint`) gets the SDK's real
 *    `DefaultChatTransport`, POSTing the UI message stream protocol. Point it
 *    at anything that speaks that protocol — a local server, a gateway — and
 *    the sidebar is a working client with no code change.
 *  - Otherwise `IpcChatTransport`, the default in the app: the agent loop
 *    runs in MAIN (main/chat/chat-service.ts) — model calls via the Vercel
 *    AI Gateway plus the browser tools — and its UIMessageChunks stream back
 *    over `chat:chunk` events, correlated by a per-send requestId. Model
 *    choice, keys, and tool execution are main's business; nothing here
 *    holds a credential.
 *  - With no window.suma bridge at all (plain-browser dev), the
 *    `LocalStubTransport` streams a canned reply so the UI stays exercisable
 *    end to end — streaming, stop, regenerate, error handling.
 */

import { DefaultChatTransport, type ChatTransport, type UIMessage, type UIMessageChunk } from "ai";

const ENDPOINT_KEY = "suma:chatEndpoint";

/** The page the user is looking at, sent alongside the prompt as context. */
export interface ChatPageContext {
  url: string;
  title: string;
}

/**
 * A page selection queued for the NEXT message (the toolbar's "Add to
 * chat"). Held in the store — the composer's own text is component state,
 * but attachments arrive from outside the sidebar — and folded into the
 * message text at send time as a quoted block, so every transport (and the
 * transcript) sees exactly what was attached.
 */
export interface ChatAttachment {
  id: string;
  text: string;
  url: string;
  title: string;
}

/** The quoted block a sent message carries for one attachment. */
export function formatChatAttachment(attachment: ChatAttachment): string {
  const source =
    attachment.title.trim() !== "" ? attachment.title.trim() : attachment.url;
  const quoted = attachment.text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return `${quoted}\n> — ${source}`;
}

/* --------------------------- dropped-file staging -------------------------- */

/**
 * A file dropped onto the sidebar, staged for the NEXT message. Three kinds,
 * split by how they reach the model:
 *  - "image" and "pdf" travel as UIMessage file parts (data: URLs) — the
 *    model sees the actual pixels/document via the provider's vision path.
 *  - "text" is decoded here and folded into the message text as a fenced
 *    block, like the selection attachments — every model reads text, and the
 *    transcript shows exactly what was sent.
 */
export interface ChatFileAttachment {
  id: string;
  name: string;
  mediaType: string;
  /** data: URL for image/pdf; empty for text (its contents ride in `text`). */
  url: string;
  kind: "image" | "pdf" | "text";
  text?: string;
}

/** Per-file ceiling. Data URLs ride inside every later request too (the chat
 *  history is re-sent per turn), so this stays deliberately modest. */
export const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;
export const MAX_FILE_ATTACHMENTS = 6;
/** A dropped text file larger than this is truncated into the message. */
const MAX_TEXT_ATTACHMENT_CHARS = 16_000;

/** What the vision path accepts across the gateway's model families. */
const IMAGE_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

/** Code-ish and prose-ish extensions accepted even when the OS reports no
 *  usable MIME type (plain files often arrive as an empty string). */
const TEXT_FILE_RE =
  /\.(txt|md|markdown|csv|tsv|json|jsonl|yaml|yml|xml|html|css|js|jsx|ts|tsx|py|rb|go|rs|java|kt|c|h|cc|cpp|sh|zsh|toml|ini|cfg|conf|log|sql|diff|patch)$/i;

export type FileAttachmentResult =
  | { ok: true; attachment: ChatFileAttachment }
  | { ok: false; reason: string };

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`could not read ${file.name}`));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(file);
  });
}

/** Classify and read one dropped file; refusals carry a toast-ready reason. */
export async function readFileAttachment(file: File): Promise<FileAttachmentResult> {
  const name = file.name || "file";
  if (file.size === 0) return { ok: false, reason: `${name} is empty` };
  if (file.size > MAX_ATTACHMENT_BYTES) {
    return { ok: false, reason: `${name} is over 4 MB` };
  }
  const id = crypto.randomUUID();
  const mediaType = file.type;
  if (IMAGE_TYPES.has(mediaType)) {
    return {
      ok: true,
      attachment: { id, name, mediaType, url: await fileToDataUrl(file), kind: "image" },
    };
  }
  if (mediaType === "application/pdf" || /\.pdf$/i.test(name)) {
    return {
      ok: true,
      attachment: {
        id,
        name,
        mediaType: "application/pdf",
        url: await fileToDataUrl(file),
        kind: "pdf",
      },
    };
  }
  if (
    mediaType.startsWith("text/") ||
    mediaType === "application/json" ||
    (mediaType === "" && TEXT_FILE_RE.test(name)) ||
    TEXT_FILE_RE.test(name)
  ) {
    return {
      ok: true,
      attachment: {
        id,
        name,
        mediaType: "text/plain",
        url: "",
        kind: "text",
        text: await file.text(),
      },
    };
  }
  return {
    ok: false,
    reason: `${name}: only images, PDFs, and text files can be attached`,
  };
}

/** The fenced block a sent message carries for one dropped text file. */
export function formatFileAttachmentText(name: string, text: string): string {
  const clamped =
    text.length > MAX_TEXT_ATTACHMENT_CHARS
      ? `${text.slice(0, MAX_TEXT_ATTACHMENT_CHARS)}\n… (truncated)`
      : text;
  // ```` fence so files containing ``` do not break out of the block.
  return `Attached file "${name}":\n\`\`\`\`\n${clamped}\n\`\`\`\``;
}

export function getChatEndpoint(): string | null {
  try {
    const raw = localStorage.getItem(ENDPOINT_KEY);
    return raw !== null && raw.trim().length > 0 ? raw.trim() : null;
  } catch {
    return null;
  }
}

export function setChatEndpoint(endpoint: string | null): void {
  try {
    if (endpoint === null || endpoint.trim().length === 0) localStorage.removeItem(ENDPOINT_KEY);
    else localStorage.setItem(ENDPOINT_KEY, endpoint.trim());
  } catch {
    // Best effort; the session keeps whatever transport it started with.
  }
}

/* ------------------------- sidebar shape, per Mac ------------------------- */

const OPEN_KEY = "suma:chatOpen";
const WIDTH_KEY = "suma:chatWidth";

export const CHAT_DEFAULT_WIDTH = 360;
/** Below this the composer and bubbles stop being usable; above it the sidebar
 *  starts crowding the page it is meant to be talking about. */
export const CHAT_MIN_WIDTH = 280;
export const CHAT_MAX_WIDTH = 620;

export function clampChatWidth(px: number): number {
  if (!Number.isFinite(px)) return CHAT_DEFAULT_WIDTH;
  return Math.min(Math.max(Math.round(px), CHAT_MIN_WIDTH), CHAT_MAX_WIDTH);
}

export function getStoredChatOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

export function storeChatOpen(open: boolean): void {
  try {
    localStorage.setItem(OPEN_KEY, open ? "1" : "0");
  } catch {
    // Best effort; the sidebar still works this session.
  }
}

export function getStoredChatWidth(): number {
  try {
    const raw = localStorage.getItem(WIDTH_KEY);
    return raw === null ? CHAT_DEFAULT_WIDTH : clampChatWidth(Number.parseInt(raw, 10));
  } catch {
    return CHAT_DEFAULT_WIDTH;
  }
}

export function storeChatWidth(px: number): void {
  try {
    localStorage.setItem(WIDTH_KEY, String(clampChatWidth(px)));
  } catch {
    // Best effort.
  }
}

/* ------------------------------- transports ------------------------------- */

/** Tokens land one at a time, at roughly the cadence of a fast model. */
const STUB_TOKEN_MS = 22;

function stubReply(messages: UIMessage[], context: ChatPageContext | null): string {
  const last = messages.at(-1);
  const asked =
    last?.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join(" ").trim() ?? "";
  const lines = [
    "No model endpoint is configured, so this reply is a local stub — the chat client is fully wired, but there is nothing on the other end yet.",
    "",
    `You asked: “${asked.length > 160 ? `${asked.slice(0, 160)}…` : asked}”`,
  ];
  if (context !== null) {
    lines.push(
      "",
      `Page context that would have been sent: ${context.title || "Untitled"} — ${context.url}`,
    );
  }
  lines.push(
    "",
    "Point Suma at an endpoint speaking the AI SDK UI message stream protocol and this becomes a real conversation.",
  );
  return lines.join("\n");
}

/** Split into word-ish tokens so the stream looks like a model, not a typewriter. */
function tokenize(text: string): string[] {
  return text.match(/\s*\S+|\s+/g) ?? [text];
}

/**
 * A no-backend transport emitting the same chunk sequence the SDK's own text
 * stream transform produces (start → start-step → text-start → deltas →
 * text-end → finish-step → finish), so `useChat` drives its status machine
 * exactly as it would against a live endpoint.
 */
class LocalStubTransport implements ChatTransport<UIMessage> {
  constructor(private readonly context: () => ChatPageContext | null) {}

  sendMessages({
    messages,
    abortSignal,
  }: {
    messages: UIMessage[];
    abortSignal: AbortSignal | undefined;
  }): Promise<ReadableStream<UIMessageChunk>> {
    const tokens = tokenize(stubReply(messages, this.context()));
    const textId = `stub-text-${messages.length}`;
    return Promise.resolve(
      new ReadableStream<UIMessageChunk>({
        async start(controller) {
          controller.enqueue({ type: "start" });
          controller.enqueue({ type: "start-step" });
          controller.enqueue({ type: "text-start", id: textId });
          for (const token of tokens) {
            // Abort (the Stop button) ends the reply where it stands, exactly
            // as a cancelled HTTP stream would — the partial text is kept.
            if (abortSignal?.aborted === true) break;
            await new Promise((resolve) => setTimeout(resolve, STUB_TOKEN_MS));
            controller.enqueue({ type: "text-delta", id: textId, delta: token });
          }
          controller.enqueue({ type: "text-end", id: textId });
          controller.enqueue({ type: "finish-step" });
          controller.enqueue({ type: "finish" });
          controller.close();
        },
      }),
    );
  }

  /** Nothing is persisted server-side, so there is never a stream to rejoin. */
  reconnectToStream(): Promise<ReadableStream<UIMessageChunk> | null> {
    return Promise.resolve(null);
  }
}

/**
 * The in-app transport: hand the UI message history to main and turn the
 * `chat:chunk` push events back into the ReadableStream `useChat` drives its
 * status machine with. One requestId per send keeps concurrent or stale runs
 * (a regenerate racing a stop) from crossing streams.
 */
class IpcChatTransport implements ChatTransport<UIMessage> {
  constructor(private readonly context: () => ChatPageContext | null) {}

  sendMessages({
    messages,
    abortSignal,
  }: {
    messages: UIMessage[];
    abortSignal: AbortSignal | undefined;
  }): Promise<ReadableStream<UIMessageChunk>> {
    const requestId = crypto.randomUUID();
    const context = this.context();
    const stream = new ReadableStream<UIMessageChunk>({
      start(controller) {
        const unsubscribe: Array<() => void> = [];
        let settled = false;
        const finish = (apply: () => void): void => {
          if (settled) return;
          settled = true;
          for (const off of unsubscribe) off();
          apply();
        };
        unsubscribe.push(
          window.suma.on("chat:chunk", (payload) => {
            if (payload.requestId !== requestId || settled) return;
            controller.enqueue(payload.chunk as UIMessageChunk);
          }),
          window.suma.on("chat:end", (payload) => {
            if (payload.requestId !== requestId) return;
            finish(() => controller.close());
          }),
          window.suma.on("chat:error", (payload) => {
            if (payload.requestId !== requestId) return;
            finish(() => controller.error(new Error(payload.message)));
          }),
        );
        // Stop button: tell main to abort; it answers with chat:end, which
        // closes this stream and keeps the partial reply.
        abortSignal?.addEventListener(
          "abort",
          () => void window.suma.invoke("chat:stop", { requestId }).catch(() => undefined),
          { once: true },
        );
        // Subscribed first, THEN started — chunks can never outrun the listener.
        window.suma
          .invoke("chat:start", { requestId, messages, context })
          .catch((err: unknown) => {
            finish(() =>
              controller.error(err instanceof Error ? err : new Error(String(err))),
            );
          });
      },
    });
    return Promise.resolve(stream);
  }

  /** Runs die with their request; there is never a stream to rejoin. */
  reconnectToStream(): Promise<ReadableStream<UIMessageChunk> | null> {
    return Promise.resolve(null);
  }
}

/**
 * The transport for this session. `context` is read at send time (not closed
 * over once) so the sidebar always attaches the tab the user is looking at
 * now, and the same value reaches the model either way.
 */
export function createChatTransport(
  context: () => ChatPageContext | null,
): ChatTransport<UIMessage> {
  const endpoint = getChatEndpoint();
  if (endpoint !== null) {
    return new DefaultChatTransport({
      api: endpoint,
      body: () => {
        const page = context();
        return page === null ? {} : { context: page };
      },
    });
  }
  if (typeof window !== "undefined" && window.suma !== undefined) {
    return new IpcChatTransport(context);
  }
  return new LocalStubTransport(context);
}
