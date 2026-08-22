/**
 * Capability groups shared by every assistant transport. External channels
 * must never get a smaller, separately-maintained tool catalog than desktop.
 */
export const ASSISTANT_TOOL_GROUPS = [
  {
    id: "tabs",
    label: "Manage tabs",
    description:
      "List open tabs, open new ones, and switch which tab is active.",
    tools: ["list_tabs", "open_tab", "select_tab"],
  },
  {
    id: "navigate",
    label: "Navigate",
    description: "Navigate, reload, or move backward and forward in a tab.",
    tools: ["navigate", "reload", "go_back", "go_forward"],
  },
  {
    id: "read",
    label: "Read pages",
    description: "Read visible page content and page metadata.",
    tools: ["read_page"],
  },
  {
    id: "screenshot",
    label: "See pages",
    description: "Take screenshots to understand pages visually.",
    tools: ["screenshot"],
  },
  {
    id: "interact",
    label: "Interact with pages",
    description:
      "Click, type, scroll, and press keys as if using a mouse and keyboard.",
    tools: ["click", "type_text", "press_key", "scroll"],
  },
  {
    id: "memory",
    label: "Memory",
    description: "Remember and retrieve durable facts across conversations.",
    tools: ["add_memory", "search_memory", "expand_memory", "compress_memory"],
  },
  {
    id: "files",
    label: "Read and write files",
    description: "Browse, read, create, and edit files in a space.",
    tools: ["list_files", "read_file", "write_file", "edit_file"],
  },
  {
    id: "terminal",
    label: "Run commands",
    description:
      "Run shell commands and coding agents, inspect terminals, and interact with processes.",
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

export type AssistantToolGroupId =
  (typeof ASSISTANT_TOOL_GROUPS)[number]["id"];

export const ASSISTANT_TOOL_GROUP_IDS: readonly AssistantToolGroupId[] =
  ASSISTANT_TOOL_GROUPS.map((group) => group.id);

export function isAssistantToolGroupId(
  value: string,
): value is AssistantToolGroupId {
  return (ASSISTANT_TOOL_GROUP_IDS as readonly string[]).includes(value);
}

export function assistantToolGroupOf(
  toolName: string,
): AssistantToolGroupId | null {
  for (const group of ASSISTANT_TOOL_GROUPS) {
    if ((group.tools as readonly string[]).includes(toolName)) return group.id;
  }
  return null;
}
