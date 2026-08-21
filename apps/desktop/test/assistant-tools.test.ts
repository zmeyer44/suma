import { describe, expect, it } from "vitest";
import { CHAT_TOOL_GROUPS } from "../src/shared/chat";
import {
  enabledAssistantTools,
  type BrowserToolDeps,
} from "../src/main/chat/chat-tools";
import { createFileTools } from "../src/main/files/assistant-fs-tools";
import type { WorkspaceFsService } from "../src/main/workspace-fs";
import type { MemoryService } from "../src/main/memory/memory-service";
import type { AssistantShellService } from "../src/main/shell/assistant-shell-service";

const browser = { spaces: {}, tabs: {} } as unknown as BrowserToolDeps;
const memory = { available: () => true } as unknown as MemoryService;
const shell = { available: () => true } as unknown as AssistantShellService;

/** Minimal in-memory WorkspaceFsService stub — only the methods the file
 *  tools call. */
function stubWorkspace(files: Record<string, string>): {
  fs: WorkspaceFsService;
  files: Record<string, string>;
  mkdirs: string[];
} {
  const mkdirs: string[] = [];
  const fs = {
    connectionStatus: () => ({
      source: "sim",
      connected: true,
      activeSpaceId: null,
    }),
    captureScope: () => "/scope",
    tree: async () => ({
      root: "/root",
      paths: Object.keys(files),
      truncated: false,
    }),
    read: async (rel: string) =>
      rel in files
        ? { path: rel, kind: "text", contents: files[rel] }
        : { path: rel, kind: "unreadable", reason: "unsupported" },
    write: async (rel: string, contents: string) => {
      files[rel] = contents;
      return { ok: true };
    },
    replace: async (
      rel: string,
      expectedContents: string,
      contents: string,
    ) => {
      if (files[rel] !== expectedContents)
        throw new Error("editing: vfs conflict");
      files[rel] = contents;
      return { ok: true };
    },
    mkdir: async (rel: string) => {
      mkdirs.push(rel);
      return { ok: true };
    },
  } as unknown as WorkspaceFsService;
  return { fs, files, mkdirs };
}

async function callTool(tool: unknown, input: unknown): Promise<unknown> {
  return (tool as { execute: (i: unknown) => Promise<unknown> }).execute(input);
}

describe("assistant tool composition", () => {
  it("adds files and terminal tools when both services are available", () => {
    const { fs } = stubWorkspace({});
    const names = Object.keys(
      enabledAssistantTools(
        { browser, memory, shell, workspaceFs: fs },
        { model: "m", tools: {} },
      ),
    );
    for (const t of ["list_files", "read_file", "write_file", "edit_file"]) {
      expect(names).toContain(t);
    }
    for (const t of [
      "run_command",
      "read_terminal",
      "send_keys",
      "list_ports",
    ]) {
      expect(names).toContain(t);
    }
  });

  it("drops the terminal group when the shell is unavailable", () => {
    const offlineShell = {
      available: () => false,
    } as unknown as AssistantShellService;
    const { fs } = stubWorkspace({});
    const names = Object.keys(
      enabledAssistantTools(
        { browser, shell: offlineShell, workspaceFs: fs },
        { model: "m", tools: {} },
      ),
    );
    expect(names.some((n) => n === "run_command")).toBe(false);
    expect(names).toContain("list_files");
  });

  it("respects the group toggles", () => {
    const { fs } = stubWorkspace({});
    const names = Object.keys(
      enabledAssistantTools(
        { browser, shell, workspaceFs: fs },
        { model: "m", tools: { terminal: false } },
      ),
    );
    expect(names).toContain("list_files");
    expect(names.some((n) => n === "run_command")).toBe(false);
  });

  it("every tool named in CHAT_TOOL_GROUPS exists in the merged set", () => {
    const { fs } = stubWorkspace({});
    const tools = enabledAssistantTools(
      { browser, memory, shell, workspaceFs: fs },
      { model: "m", tools: {} },
    );
    for (const group of CHAT_TOOL_GROUPS) {
      for (const name of group.tools) {
        expect(Object.keys(tools)).toContain(name);
      }
    }
  });
});

describe("file tools", () => {
  it("write_file creates parent folders", async () => {
    const { fs, files, mkdirs } = stubWorkspace({});
    const tools = createFileTools(fs);
    await callTool(tools["write_file"], {
      path: "src/app/page.tsx",
      contents: "x",
    });
    expect(mkdirs).toContain("src/app");
    expect(files["src/app/page.tsx"]).toBe("x");
  });

  it("edit_file requires oldText to occur exactly once", async () => {
    const { fs } = stubWorkspace({ "a.ts": "let x = 1;\nlet x = 1;\n" });
    const tools = createFileTools(fs);
    await expect(
      callTool(tools["edit_file"], {
        path: "a.ts",
        oldText: "let x = 1;",
        newText: "let y = 2;",
      }),
    ).rejects.toThrow(/more than once/);
  });

  it("edit_file replaces a unique snippet", async () => {
    const { fs, files } = stubWorkspace({
      "a.ts": "const a = 1;\nconst b = 2;\n",
    });
    const tools = createFileTools(fs);
    await callTool(tools["edit_file"], {
      path: "a.ts",
      oldText: "const b = 2;",
      newText: "const b = 3;",
    });
    expect(files["a.ts"]).toBe("const a = 1;\nconst b = 3;\n");
  });

  it("edit_file refuses to overwrite a concurrent change", async () => {
    const files = { "a.ts": "const value = 1;\n" };
    const { fs } = stubWorkspace(files);
    const originalRead = fs.read.bind(fs);
    fs.read = async (rel: string) => {
      const result = await originalRead(rel);
      files["a.ts"] = "const value = 9;\n";
      return result;
    };
    const tools = createFileTools(fs);
    await expect(
      callTool(tools["edit_file"], {
        path: "a.ts",
        oldText: "const value = 1;",
        newText: "const value = 2;",
      }),
    ).rejects.toThrow(/conflict/);
    expect(files["a.ts"]).toBe("const value = 9;\n");
  });

  it("list_files filters by subtree prefix", async () => {
    const { fs } = stubWorkspace({
      "src/a.ts": "",
      "src/b.ts": "",
      "README.md": "",
    });
    const tools = createFileTools(fs);
    const result = (await callTool(tools["list_files"], { path: "src" })) as {
      files: string[];
    };
    expect(result.files.sort()).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("read_file refuses a missing/unreadable file with a reason", async () => {
    const { fs } = stubWorkspace({});
    const tools = createFileTools(fs);
    await expect(
      callTool(tools["read_file"], { path: "nope.ts" }),
    ).rejects.toThrow(/cannot read/);
  });
});
