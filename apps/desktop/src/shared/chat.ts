/**
 * The AI assistant's shared contract — pure and imported by BOTH processes.
 *
 * Main runs the agent loop (main/chat/chat-service.ts): the Vercel AI Gateway
 * key stays there, and the browser tools need the tab WebContentsViews, which
 * only main holds. The renderer needs the same vocabulary to render settings —
 * which model, which tool groups — so the catalog lives here, next to the
 * settings parse/merge helpers, exactly like shared/tts.ts does for voice.
 *
 * Nothing here touches the network or the filesystem; everything is testable.
 */

/* ------------------------------- tool groups ------------------------------ */

/**
 * The permission granularity the settings page offers. Individual tools are
 * main's implementation detail (open_tab and select_tab ride together); what
 * the user reasons about is capabilities: "may it read my pages?", "may it
 * click things?".
 */
export const CHAT_TOOL_GROUPS = [
  {
    id: "tabs",
    label: "Manage tabs",
    description:
      "List your open tabs, open new ones, and switch which tab is active.",
    tools: ["list_tabs", "open_tab", "select_tab"],
  },
  {
    id: "navigate",
    label: "Navigate",
    description: "Send a tab to a web address.",
    tools: ["navigate"],
  },
  {
    id: "read",
    label: "Read pages",
    description:
      "Read the text of pages so it can answer questions about them.",
    tools: ["read_page"],
  },
  {
    id: "screenshot",
    label: "See pages",
    description:
      "Take screenshots of pages to understand how they look visually.",
    tools: ["screenshot"],
  },
  {
    id: "interact",
    label: "Interact with pages",
    description:
      "Click, type, scroll, and press keys on pages — acting on the page as if it were using the mouse and keyboard.",
    tools: ["click", "type_text", "press_key", "scroll"],
  },
  {
    id: "memory",
    label: "Memory",
    description:
      "Remember lasting details about you across conversations — preferences, people, plans — and search what it has remembered. Stored in your own files (.suma/memory).",
    tools: ["add_memory", "search_memory", "expand_memory", "compress_memory"],
  },
  {
    id: "files",
    label: "Read and write files",
    description:
      "Browse, read, create, and edit files in your space's folder — the same files the built-in IDE shows.",
    tools: ["list_files", "read_file", "write_file", "edit_file"],
  },
  {
    id: "terminal",
    label: "Run commands",
    description:
      "Run shell commands and coding agents in terminals on your computer, watch their output, and see which local ports are serving. Every shell it opens is visible in your terminal panel.",
    tools: [
      "run_command",
      "wait_for_output",
      "read_terminal",
      "send_keys",
      "open_terminal_app",
      "kill_shell",
      "list_ports",
    ],
  },
] as const;

export type ChatToolGroupId = (typeof CHAT_TOOL_GROUPS)[number]["id"];

export const CHAT_TOOL_GROUP_IDS: readonly ChatToolGroupId[] =
  CHAT_TOOL_GROUPS.map((group) => group.id);

export function isChatToolGroupId(value: string): value is ChatToolGroupId {
  return (CHAT_TOOL_GROUP_IDS as readonly string[]).includes(value);
}

/** Which group a concrete tool belongs to — main filters the ToolSet with it. */
export function toolGroupOf(toolName: string): ChatToolGroupId | null {
  for (const group of CHAT_TOOL_GROUPS) {
    if ((group.tools as readonly string[]).includes(toolName)) return group.id;
  }
  return null;
}

/* --------------------------------- models --------------------------------- */

/**
 * Curated gateway model ids (the Vercel AI Gateway spells them
 * `provider/model`). The picker is not a cage: the settings page also accepts
 * any free-typed gateway id, so a model launched tomorrow needs no release.
 */
export const CHAT_MODELS: ReadonlyArray<{
  id: string;
  label: string;
  hint?: string;
}> = [
  {
    id: "anthropic/claude-opus-5",
    label: "Claude Opus 5",
    hint: "most capable",
  },
  {
    id: "anthropic/claude-sonnet-5",
    label: "Claude Sonnet 5",
    hint: "fast and capable",
  },
  {
    id: "anthropic/claude-haiku-4-5",
    label: "Claude Haiku 4.5",
    hint: "fastest",
  },
  { id: "openai/gpt-5.1", label: "GPT-5.1" },
  { id: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro" },
  { id: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash" },
];

export const DEFAULT_CHAT_MODEL = "anthropic/claude-opus-5";

/* -------------------------------- settings -------------------------------- */

/** What main persists (chat.json) — no credentials, ever (the gateway key
 *  lives with the TTS settings or the environment). */
export interface ChatSettings {
  model: string;
  /** Missing group ⇒ enabled: a new capability ships on. */
  tools: Partial<Record<ChatToolGroupId, boolean>>;
}

export const DEFAULT_CHAT_SETTINGS: ChatSettings = {
  model: DEFAULT_CHAT_MODEL,
  tools: {},
};

/** Where the gateway credential came from, for the settings page's status
 *  line. Never the key itself. Precedence: env, then a stored key, then
 *  "vended" — model access through the signed-in control plane's
 *  /v1/ai/gateway proxy, no key on this machine at all. */
export type ChatKeyState = "env" | "stored" | "vended" | "unset";

/** The renderer-facing view of the assistant's configuration. */
export interface ChatSettingsInfo {
  model: string;
  tools: Record<ChatToolGroupId, boolean>;
  keyState: ChatKeyState;
}

export interface ChatSettingsPatch {
  model?: string;
  tools?: Partial<Record<ChatToolGroupId, boolean>>;
}

export function isToolGroupEnabled(
  settings: ChatSettings,
  group: ChatToolGroupId,
): boolean {
  return settings.tools[group] !== false;
}

/** Parse persisted settings; anything malformed falls back field-by-field. */
export function parseChatSettings(raw: string): ChatSettings {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_CHAT_SETTINGS, tools: {} };
  }
  if (typeof data !== "object" || data === null) {
    return { ...DEFAULT_CHAT_SETTINGS, tools: {} };
  }
  const record = data as Record<string, unknown>;
  const model =
    typeof record["model"] === "string" && record["model"].trim() !== ""
      ? record["model"].trim()
      : DEFAULT_CHAT_MODEL;
  const tools: Partial<Record<ChatToolGroupId, boolean>> = {};
  const rawTools = record["tools"];
  if (typeof rawTools === "object" && rawTools !== null) {
    for (const [key, value] of Object.entries(rawTools)) {
      if (isChatToolGroupId(key) && typeof value === "boolean") {
        tools[key] = value;
      }
    }
  }
  return { model, tools };
}

/** Apply a renderer patch. Unknown groups and empty models are dropped, not
 *  errors — the reply always shows what was really stored. */
export function mergeChatSettings(
  current: ChatSettings,
  patch: ChatSettingsPatch,
): ChatSettings {
  const next: ChatSettings = {
    model: current.model,
    tools: { ...current.tools },
  };
  if (typeof patch.model === "string" && patch.model.trim() !== "") {
    next.model = patch.model.trim();
  }
  if (typeof patch.tools === "object" && patch.tools !== null) {
    for (const [key, value] of Object.entries(patch.tools)) {
      if (isChatToolGroupId(key) && typeof value === "boolean") {
        next.tools[key] = value;
      }
    }
  }
  return next;
}

export function chatSettingsInfo(
  settings: ChatSettings,
  keyState: ChatKeyState,
): ChatSettingsInfo {
  const tools = {} as Record<ChatToolGroupId, boolean>;
  for (const group of CHAT_TOOL_GROUP_IDS) {
    tools[group] = isToolGroupEnabled(settings, group);
  }
  return { model: settings.model, tools, keyState };
}

export const CHAT_SETTINGS_FILENAME = "chat.json";

/* ----------------------------- streaming wire ----------------------------- */

/**
 * One agent run over IPC. The renderer mints the requestId; every chunk event
 * echoes it so interleaved runs (two windows, a stale abort) can never cross.
 * Chunks are the AI SDK's UIMessageChunk objects, passed through verbatim —
 * this module deliberately does not re-declare their shape.
 */
export interface ChatStreamRequest {
  requestId: string;
  /** The UI message history, exactly as `useChat` holds it. */
  messages: unknown[];
  /** The page the user is looking at, when attached. */
  context: { url: string; title: string } | null;
}

export interface ChatChunkEvent {
  requestId: string;
  chunk: unknown;
}

export interface ChatErrorEvent {
  requestId: string;
  message: string;
}
