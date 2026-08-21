/**
 * The assistant's terminal tools — an AI SDK ToolSet over
 * AssistantShellService. Runs shell commands, drives interactive terminal
 * programs (Claude Code etc.), and reports listening ports for previewing dev
 * servers. Every shell is one the user can see in the terminal panel.
 *
 * Failures throw Errors (recoverable tool results, repo convention). The
 * service enforces timeouts, output budgets, and shell caps.
 */

import { jsonSchema, tool, type ToolSet } from "ai";
import { SEND_KEY_NAMES } from "./assistant-shell-core";
import type { AssistantShellService } from "./assistant-shell-service";

export function createShellTools(shell: AssistantShellService): ToolSet {
  return {
    run_command: tool({
      description:
        "Run a shell command on the user's computer, in the workspace folder, and get its output and exit code. The command runs under bash; multiline scripts and heredocs are fine. `cd` does NOT carry over between calls — pass cwd instead. Default timeout 120s (max 600); on timeout you get the output so far plus the shellId, and can keep waiting with wait_for_output or stop it with kill_shell. Set background:true for long-lived processes like dev servers or watchers — it returns immediately with a shellId so you can read_terminal, list_ports, and preview; a background process runs while the computer is awake (for unattended runs, tell the user to turn on Job Mode in the terminal panel).",
      inputSchema: jsonSchema<{
        command: string;
        cwd?: string;
        background?: boolean;
        timeoutSeconds?: number;
      }>({
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The command or script to run.",
          },
          cwd: {
            type: "string",
            description:
              'Workspace-relative directory to run in, e.g. "my-app". Defaults to the workspace root.',
          },
          background: {
            type: "boolean",
            description:
              "Return immediately without waiting for completion — for servers and watchers.",
          },
          timeoutSeconds: {
            type: "number",
            description:
              "How long to wait for completion (default 120, max 600).",
          },
        },
        required: ["command"],
        additionalProperties: false,
      }),
      execute: async (
        { command, cwd, background, timeoutSeconds },
        { abortSignal },
      ) => shell.run({ command, cwd, background, timeoutSeconds }, abortSignal),
    }),

    wait_for_output: tool({
      description:
        "Keep waiting on a shell that hasn't finished (from a timed-out run_command or a background process). Returns when the command completes, when the optional text pattern appears in the output, or when this wait times out.",
      inputSchema: jsonSchema<{
        shellId: string;
        timeoutSeconds?: number;
        pattern?: string;
      }>({
        type: "object",
        properties: {
          shellId: { type: "string", description: "The shell to watch." },
          timeoutSeconds: {
            type: "number",
            description: "How long to wait (default 120, max 600).",
          },
          pattern: {
            type: "string",
            description:
              'Optional literal text to wait for, e.g. "ready in" or "Local:".',
          },
        },
        required: ["shellId"],
        additionalProperties: false,
      }),
      execute: async ({ shellId, timeoutSeconds, pattern }, { abortSignal }) =>
        shell.waitForOutput(shellId, { timeoutSeconds, pattern }, abortSignal),
    }),

    read_terminal: tool({
      description:
        'Read a shell\'s current output. mode "screen" shows what the terminal displays right now — use it for interactive full-screen programs like claude; mode "tail" returns the most recent output lines (better for scrolling logs).',
      inputSchema: jsonSchema<{
        shellId: string;
        mode?: "screen" | "tail";
        lines?: number;
      }>({
        type: "object",
        properties: {
          shellId: { type: "string", description: "The shell to read." },
          mode: {
            type: "string",
            enum: ["screen", "tail"],
            description: '"screen" (default) or "tail".',
          },
          lines: {
            type: "number",
            description: 'For "tail": how many recent lines (default 200).',
          },
        },
        required: ["shellId"],
        additionalProperties: false,
      }),
      execute: ({ shellId, mode, lines }) =>
        shell.readTerminal(shellId, mode ?? "screen", lines ?? 200),
    }),

    send_keys: tool({
      description:
        "Send keystrokes to an interactive shell — type text and/or press named keys. Use it to answer prompts and drive terminal apps (e.g. type a message to claude, then press Enter). Returns the terminal screen after a short settle. Named keys: " +
        `${SEND_KEY_NAMES.join(", ")}.`,
      inputSchema: jsonSchema<{
        shellId: string;
        text?: string;
        keys?: string[];
      }>({
        type: "object",
        properties: {
          shellId: { type: "string", description: "The shell to type into." },
          text: {
            type: "string",
            description: "Literal text to type (no automatic Enter).",
          },
          keys: {
            type: "array",
            items: { type: "string" },
            description:
              'Named keys to press after the text, e.g. ["Enter"] or ["C-c"].',
          },
        },
        required: ["shellId"],
        additionalProperties: false,
      }),
      execute: ({ shellId, text, keys }, { abortSignal }) =>
        shell.sendKeys(shellId, text, keys, abortSignal),
    }),

    open_terminal_app: tool({
      description:
        'Start an interactive terminal program in a dedicated shell — for example `claude` to launch Claude Code, or a REPL. Returns a shellId and the initial screen; drive it afterwards with send_keys and read_terminal. For a one-shot coding task, prefer run_command with `claude -p "<task>" --permission-mode acceptEdits` instead, which runs headless and returns when done. Single-line command only.',
      inputSchema: jsonSchema<{ command?: string }>({
        type: "object",
        properties: {
          command: {
            type: "string",
            description:
              'The program to launch, e.g. "claude". Omit for a bare shell.',
          },
        },
        additionalProperties: false,
      }),
      execute: ({ command }, { abortSignal }) =>
        shell.openInteractive(command, abortSignal),
    }),

    kill_shell: tool({
      description:
        "Stop a shell and the process running in it (interrupt, then close). Use it to end a background dev server or a stuck command.",
      inputSchema: jsonSchema<{ shellId: string }>({
        type: "object",
        properties: {
          shellId: { type: "string", description: "The shell to stop." },
        },
        required: ["shellId"],
        additionalProperties: false,
      }),
      execute: async ({ shellId }) => {
        await shell.killShell(shellId);
        return { ok: true };
      },
    }),

    list_ports: tool({
      description:
        "List the ports currently serving on the user's computer (e.g. a dev server you started). Each entry has the port, the process, and a localUrl — open that URL in a tab to preview it (forwarding from a cloud computer happens automatically on navigation), then select_tab and screenshot.",
      inputSchema: jsonSchema<Record<string, never>>({
        type: "object",
        properties: {},
        additionalProperties: false,
      }),
      execute: async () => ({ ports: await shell.listPorts() }),
    }),
  };
}
