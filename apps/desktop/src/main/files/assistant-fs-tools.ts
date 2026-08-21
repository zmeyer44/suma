/**
 * The assistant's file tools — an AI SDK ToolSet over WorkspaceFsService.
 *
 * Files live in the active space's folder, the exact scoped view the IDE and
 * Files UI show (WorkspaceFsService normalizes paths, refuses escapes, and a
 * write triggers the IDE's refresh). Paths the model passes are
 * workspace-relative — the same coordinate system the user sees in the
 * explorer. Failures are thrown Errors, which the SDK turns into recoverable
 * tool results (same contract as the browser and memory tools).
 */

import path from "node:path";
import { jsonSchema, tool, type ToolSet } from "ai";
import type { WorkspaceFsService } from "../workspace-fs";

/** Read/edit clamp — a file bigger than this is summarized, not dumped into
 *  the model's context. */
const READ_MAX_BYTES = 48 * 1024;
/** Write ceiling — generated source, not media. */
const WRITE_MAX_BYTES = 2 * 1024 * 1024;
/** list_files entry cap, so a huge tree can't flood one tool result. */
const LIST_MAX = 400;

function requireAvailable(fs: WorkspaceFsService): void {
  if (!fs.connectionStatus(null).connected) {
    throw new Error(
      "no computer is connected right now — it may be waking or offline; try again shortly",
    );
  }
}

/** Ensure the parent directory exists — vfs.write does not create it. */
async function ensureParent(
  fs: WorkspaceFsService,
  rel: string,
): Promise<void> {
  const parent = path.posix.dirname(rel.replace(/^\/+/u, ""));
  if (parent !== "" && parent !== ".") await fs.mkdir(parent);
}

export function createFileTools(fs: WorkspaceFsService): ToolSet {
  return {
    list_files: tool({
      description:
        "List files in the workspace — the active space's folder, the same files shown in the IDE. Paths are workspace-relative; node_modules, .git and other noise are omitted. Optionally pass a path prefix to list a subtree.",
      inputSchema: jsonSchema<{ path?: string }>({
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              'Optional subtree prefix, e.g. "src". Omit for the whole workspace.',
          },
        },
        additionalProperties: false,
      }),
      execute: async ({ path: prefix }) => {
        requireAvailable(fs);
        const tree = await fs.tree();
        const clean = (prefix ?? "").replace(/^\/+|\/+$/gu, "");
        let files = tree.paths;
        if (clean !== "") {
          files = files.filter((p) => p === clean || p.startsWith(`${clean}/`));
        }
        const capped = files.slice(0, LIST_MAX);
        return {
          files: capped,
          ...(capped.length < files.length || tree.truncated
            ? {
                truncated: `showing ${capped.length} of ${files.length} entries`,
              }
            : {}),
        };
      },
    }),

    read_file: tool({
      description:
        "Read a text file from the workspace. Binary and oversized files are refused with a reason instead of returned.",
      inputSchema: jsonSchema<{ path: string }>({
        type: "object",
        properties: {
          path: {
            type: "string",
            description: 'Workspace-relative path, e.g. "src/app/page.tsx".',
          },
        },
        required: ["path"],
        additionalProperties: false,
      }),
      execute: async ({ path: rel }) => {
        requireAvailable(fs);
        const file = await fs.read(rel);
        if (file.kind === "text") {
          if (file.contents.length > READ_MAX_BYTES) {
            return {
              path: rel,
              contents: file.contents.slice(0, READ_MAX_BYTES),
              truncated: `file is larger than ${READ_MAX_BYTES} bytes; showing the start`,
            };
          }
          return { path: rel, contents: file.contents };
        }
        if (file.kind === "image" || file.kind === "audio") {
          throw new Error(
            `"${rel}" is ${file.kind}, not text — open it in the browser to view it`,
          );
        }
        throw new Error(`cannot read "${rel}": ${file.reason}`);
      },
    }),

    write_file: tool({
      description:
        "Create or overwrite a text file in the workspace, creating parent folders as needed. Use for new files or full rewrites; use edit_file for targeted changes to an existing file.",
      inputSchema: jsonSchema<{ path: string; contents: string }>({
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative path." },
          contents: {
            type: "string",
            description: "The complete file contents.",
          },
        },
        required: ["path", "contents"],
        additionalProperties: false,
      }),
      execute: async ({ path: rel, contents }) => {
        requireAvailable(fs);
        const bytes = Buffer.byteLength(contents, "utf8");
        if (bytes > WRITE_MAX_BYTES) {
          throw new Error(
            `too large: ${bytes} bytes (limit ${WRITE_MAX_BYTES})`,
          );
        }
        await ensureParent(fs, rel);
        await fs.write(rel, contents);
        return { ok: true, path: rel, bytes };
      },
    }),

    edit_file: tool({
      description:
        "Replace an exact snippet in an existing workspace file. oldText must appear EXACTLY ONCE — include enough surrounding lines to make it unique. For new files or whole rewrites use write_file.",
      inputSchema: jsonSchema<{
        path: string;
        oldText: string;
        newText: string;
      }>({
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative path." },
          oldText: {
            type: "string",
            description: "The exact text to replace (must occur once).",
          },
          newText: { type: "string", description: "The replacement text." },
        },
        required: ["path", "oldText", "newText"],
        additionalProperties: false,
      }),
      execute: async ({ path: rel, oldText, newText }) => {
        requireAvailable(fs);
        const scope = fs.captureScope();
        const file = await fs.read(rel, scope);
        if (file.kind !== "text") {
          throw new Error(
            file.kind === "unreadable"
              ? `cannot edit "${rel}": ${file.reason}`
              : `"${rel}" is ${file.kind}, not editable text`,
          );
        }
        const first = file.contents.indexOf(oldText);
        if (first === -1) {
          throw new Error(
            `oldText not found in "${rel}" — read the file and match it exactly`,
          );
        }
        if (file.contents.indexOf(oldText, first + 1) !== -1) {
          throw new Error(
            `oldText appears more than once in "${rel}" — include more surrounding lines to make it unique`,
          );
        }
        const next = file.contents.replace(oldText, () => newText);
        const bytes = Buffer.byteLength(next, "utf8");
        if (bytes > WRITE_MAX_BYTES) {
          throw new Error(
            `too large after edit: ${bytes} bytes (limit ${WRITE_MAX_BYTES})`,
          );
        }
        await fs.replace(rel, file.contents, next, scope);
        return { ok: true, path: rel };
      },
    }),
  };
}
