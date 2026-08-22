import { jsonSchema, tool, type ToolSet } from "ai";

export interface ComputerRunResult {
  shellId: string;
  output: string;
  exitCode: number | null;
  timedOut?: boolean;
}

export interface ComputerBackend {
  runCommand(input: {
    command: string;
    cwd?: string;
    background?: boolean;
    timeoutSeconds?: number;
  }): Promise<ComputerRunResult>;
  waitForOutput(input: {
    shellId: string;
    timeoutSeconds?: number;
    pattern?: string;
  }): Promise<ComputerRunResult>;
  readTerminal(shellId: string): Promise<{ shellId: string; output: string }>;
  sendKeys(shellId: string, keys: string): Promise<{ shellId: string; sent: true }>;
  openTerminalApp(command: string, cwd?: string): Promise<{ shellId: string; output: string }>;
  killShell(shellId: string): Promise<{ shellId: string; killed: true }>;
  listPorts(): Promise<Array<{ port: number; process: string; localUrl: string }>>;
  listFiles(path?: string): Promise<{ files: string[]; truncated?: string }>;
  readFile(path: string): Promise<{ path: string; contents: string; truncated?: string }>;
  writeFile(path: string, contents: string): Promise<{ ok: true; path: string; bytes: number }>;
  editFile(
    path: string,
    oldText: string,
    newText: string,
  ): Promise<{ ok: true; path: string }>;
  addMemory(text: string): Promise<{ saved: string }>;
  searchMemory(query: string): Promise<{ matches: string[]; note?: string }>;
  expandMemory(block: string): Promise<{ entries: string[] }>;
  compressMemory(block: string, summary: string): Promise<{ result: string }>;
}

/** Channel-neutral computer vocabulary used by desktop and remote runners. */
export function createComputerToolSet(backend: ComputerBackend): ToolSet {
  return {
    run_command: tool({
      description:
        "Run a shell command on the user's computer and return output and exit status. Use background for servers or long-running jobs.",
      inputSchema: jsonSchema<{
        command: string;
        cwd?: string;
        background?: boolean;
        timeoutSeconds?: number;
      }>({
        type: "object",
        properties: {
          command: { type: "string" },
          cwd: { type: "string" },
          background: { type: "boolean" },
          timeoutSeconds: { type: "number" },
        },
        required: ["command"],
        additionalProperties: false,
      }),
      execute: (input) => backend.runCommand(input),
    }),
    wait_for_output: tool({
      description: "Wait for a running shell to finish or produce a text pattern.",
      inputSchema: jsonSchema<{
        shellId: string;
        timeoutSeconds?: number;
        pattern?: string;
      }>({
        type: "object",
        properties: {
          shellId: { type: "string" },
          timeoutSeconds: { type: "number" },
          pattern: { type: "string" },
        },
        required: ["shellId"],
        additionalProperties: false,
      }),
      execute: (input) => backend.waitForOutput(input),
    }),
    read_terminal: tool({
      description: "Read the current output of an assistant shell.",
      inputSchema: idSchema(),
      execute: ({ shellId }) => backend.readTerminal(shellId),
    }),
    send_keys: tool({
      description: "Send text or control-key input to an interactive assistant shell.",
      inputSchema: jsonSchema<{ shellId: string; keys: string }>({
        type: "object",
        properties: { shellId: { type: "string" }, keys: { type: "string" } },
        required: ["shellId", "keys"],
        additionalProperties: false,
      }),
      execute: ({ shellId, keys }) => backend.sendKeys(shellId, keys),
    }),
    open_terminal_app: tool({
      description: "Start an interactive terminal program such as a coding agent.",
      inputSchema: jsonSchema<{ command: string; cwd?: string }>({
        type: "object",
        properties: { command: { type: "string" }, cwd: { type: "string" } },
        required: ["command"],
        additionalProperties: false,
      }),
      execute: ({ command, cwd }) => backend.openTerminalApp(command, cwd),
    }),
    kill_shell: tool({
      description: "Stop an assistant shell and its current process.",
      inputSchema: idSchema(),
      execute: ({ shellId }) => backend.killShell(shellId),
    }),
    list_ports: tool({
      description: "List network ports currently listening on the user's computer.",
      inputSchema: emptySchema(),
      execute: () => backend.listPorts(),
    }),
    list_files: tool({
      description: "List files in the remote workspace, optionally under a path.",
      inputSchema: jsonSchema<{ path?: string }>({
        type: "object",
        properties: { path: { type: "string" } },
        additionalProperties: false,
      }),
      execute: ({ path }) => backend.listFiles(path),
    }),
    read_file: tool({
      description: "Read a text file from the remote workspace.",
      inputSchema: pathSchema(),
      execute: ({ path }) => backend.readFile(path),
    }),
    write_file: tool({
      description: "Create or overwrite a text file in the remote workspace.",
      inputSchema: jsonSchema<{ path: string; contents: string }>({
        type: "object",
        properties: { path: { type: "string" }, contents: { type: "string" } },
        required: ["path", "contents"],
        additionalProperties: false,
      }),
      execute: ({ path, contents }) => backend.writeFile(path, contents),
    }),
    edit_file: tool({
      description: "Replace one exact snippet in an existing remote workspace file.",
      inputSchema: jsonSchema<{ path: string; oldText: string; newText: string }>({
        type: "object",
        properties: {
          path: { type: "string" },
          oldText: { type: "string" },
          newText: { type: "string" },
        },
        required: ["path", "oldText", "newText"],
        additionalProperties: false,
      }),
      execute: ({ path, oldText, newText }) =>
        backend.editFile(path, oldText, newText),
    }),
    add_memory: tool({
      description: "Save one lasting fact to the user's cross-conversation memory.",
      inputSchema: textSchema(),
      execute: ({ text }) => backend.addMemory(text),
    }),
    search_memory: tool({
      description: "Search the user's permanent memory.",
      inputSchema: jsonSchema<{ query: string }>({
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false,
      }),
      execute: ({ query }) => backend.searchMemory(query),
    }),
    expand_memory: tool({
      description: "Open a memory block such as 1-16.",
      inputSchema: blockSchema(false),
      execute: ({ block }) => backend.expandMemory(block),
    }),
    compress_memory: tool({
      description: "Save a one-line summary for a memory block.",
      inputSchema: blockSchema(true),
      execute: ({ block, summary }) =>
        backend.compressMemory(block, summary ?? ""),
    }),
  };
}

function emptySchema() {
  return jsonSchema<Record<string, never>>({
    type: "object",
    properties: {},
    additionalProperties: false,
  });
}

function idSchema() {
  return jsonSchema<{ shellId: string }>({
    type: "object",
    properties: { shellId: { type: "string" } },
    required: ["shellId"],
    additionalProperties: false,
  });
}

function pathSchema() {
  return jsonSchema<{ path: string }>({
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
    additionalProperties: false,
  });
}

function textSchema() {
  return jsonSchema<{ text: string }>({
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
    additionalProperties: false,
  });
}

function blockSchema(withSummary: boolean) {
  return jsonSchema<{ block: string; summary?: string }>({
    type: "object",
    properties: {
      block: { type: "string" },
      ...(withSummary ? { summary: { type: "string" } } : {}),
    },
    required: withSummary ? ["block", "summary"] : ["block"],
    additionalProperties: false,
  });
}
