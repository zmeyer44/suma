import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import type { AgentLink, PtyChannel } from "@suma/agent-client";
import type {
  ComputerBackend,
  ComputerRunResult,
} from "@suma/assistant-core/computer";
import { normalizeVfsPath, type VfsResponse } from "@suma/protocol";

const OUTPUT_LIMIT = 1024 * 1024;
const READ_LIMIT = 48 * 1024;
const WRITE_LIMIT = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_SECONDS = 120;
const MAX_TIMEOUT_SECONDS = 600;
const MEMORY_PATH = "/.suma/assistant-memory.jsonl";
const MEMORY_SUMMARY_PATH = "/.suma/assistant-memory-summaries.jsonl";
const ANSI_ESCAPE = new RegExp(
  `${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`,
  "gu",
);

interface RemoteShell {
  shellId: string;
  channel: PtyChannel;
  output: string;
  marker: string | null;
  exitCode: number | null;
  listeners: Set<() => void>;
}

interface MemoryRecord {
  id: number;
  date: string;
  text: string;
}

/** VM-backed terminal, file, and memory implementation for external turns. */
export class RemoteComputerBackend implements ComputerBackend {
  readonly #link: AgentLink;
  readonly #workspaceRoot: string;
  readonly #shells = new Map<string, RemoteShell>();
  #memoryTail: Promise<void> = Promise.resolve();

  constructor(options: { link: AgentLink; workspaceRoot?: string }) {
    this.#link = options.link;
    this.#workspaceRoot = options.workspaceRoot ?? this.#link.vfsRootLabel();
    this.#link.onCtlEvent((event) => {
      if (event.t !== "pty.exited") return;
      const shell = this.#shells.get(event.ptyId);
      if (shell === undefined || shell.exitCode !== null) return;
      shell.exitCode = event.code;
      this.#notify(shell);
    });
  }

  async runCommand(input: {
    command: string;
    cwd?: string;
    background?: boolean;
    timeoutSeconds?: number;
  }): Promise<ComputerRunResult> {
    if (input.command.trim() === "") throw new Error("command cannot be empty");
    const shell = await this.#spawnShell();
    const marker = `__SUMA_REMOTE_DONE_${randomBytes(12).toString("hex")}__`;
    shell.marker = marker;
    const encoded = Buffer.from(input.command, "utf8").toString("base64");
    const cwd = shellQuote(input.cwd?.trim() || this.#workspaceRoot);
    shell.channel.write(
      `cd -- ${cwd} && /bin/bash -c "$(printf %s ${shellQuote(encoded)} | base64 -d)"; ` +
        `code=$?; printf '\\n${marker}:%s\\n' "$code"\n`,
    );
    if (input.background === true) return this.#present(shell);
    return this.#wait(shell, clampTimeout(input.timeoutSeconds));
  }

  async waitForOutput(input: {
    shellId: string;
    timeoutSeconds?: number;
    pattern?: string;
  }): Promise<ComputerRunResult> {
    const shell = await this.#requireShell(input.shellId);
    return this.#wait(
      shell,
      clampTimeout(input.timeoutSeconds),
      input.pattern?.trim() || undefined,
    );
  }

  async readTerminal(shellId: string): Promise<{ shellId: string; output: string }> {
    const shell = await this.#requireShell(shellId);
    return { shellId, output: cleanOutput(shell.output) };
  }

  async sendKeys(shellId: string, keys: string): Promise<{ shellId: string; sent: true }> {
    const shell = await this.#requireShell(shellId);
    const mapped = keys === "ENTER"
      ? "\r"
      : keys === "CTRL_C"
        ? "\u0003"
        : keys === "ESCAPE"
          ? "\u001b"
          : keys;
    shell.channel.write(mapped);
    return { shellId, sent: true };
  }

  async openTerminalApp(
    command: string,
    cwd?: string,
  ): Promise<{ shellId: string; output: string }> {
    if (command.trim() === "" || command.includes("\n")) {
      throw new Error("interactive command must be one non-empty line");
    }
    const shell = await this.#spawnShell();
    shell.channel.write(`cd -- ${shellQuote(cwd?.trim() || this.#workspaceRoot)}\n`);
    shell.channel.write(`${command}\n`);
    await this.#waitForChange(shell, 700);
    return { shellId: shell.shellId, output: cleanOutput(shell.output) };
  }

  async killShell(shellId: string): Promise<{ shellId: string; killed: true }> {
    const shell = await this.#requireShell(shellId);
    await this.#link.ctl({ t: "pty.kill", ptyId: shellId, signal: "TERM" });
    shell.channel.close();
    shell.exitCode ??= -1;
    this.#notify(shell);
    return { shellId, killed: true };
  }

  async listPorts(): Promise<
    Array<{ port: number; process: string; localUrl: string }>
  > {
    const response = await this.#link.ctl({ t: "ports.list" });
    if (response?.t === "error") throw new Error(response.message);
    if (response?.t !== "ports") throw new Error("unexpected ports response");
    return response.ports.map((port) => ({
      port: port.port,
      process: port.process,
      localUrl: `http://localhost:${String(port.port)}`,
    }));
  }

  async listFiles(prefix?: string): Promise<{ files: string[]; truncated?: string }> {
    const root = this.#filePath(prefix ?? "");
    let response = await this.#link.vfs({ t: "vfs.tree", path: root });
    if (response.t === "error" && response.code === "vfs_not_found") {
      unwrap(await this.#link.vfs({ t: "vfs.mkdir", path: root }), "creating folder");
      response = await this.#link.vfs({ t: "vfs.tree", path: root });
    }
    const paths = unwrap(response, "listing files");
    if (paths.t !== "vfs.paths") throw new Error("unexpected file listing");
    const base = root === "/" ? "/" : `${root}/`;
    const files = paths.paths.map((entry) =>
      entry === root ? "" : entry.startsWith(base) ? entry.slice(base.length) : entry,
    ).filter((entry) => entry !== "").slice(0, 400);
    return {
      files,
      ...(paths.truncated || paths.paths.length > files.length
        ? { truncated: `showing ${String(files.length)} entries` }
        : {}),
    };
  }

  async readFile(rel: string): Promise<{
    path: string;
    contents: string;
    truncated?: string;
  }> {
    const wire = this.#filePath(rel);
    const info = unwrap(
      await this.#link.vfs({ t: "vfs.stat", path: wire }),
      `reading ${rel}`,
    );
    if (info.t !== "vfs.info" || info.entry.kind !== "file") {
      throw new Error(`"${rel}" is not a file`);
    }
    if (info.entry.sizeBytes === 0) return { path: rel, contents: "" };
    const length = Math.min(info.entry.sizeBytes, READ_LIMIT);
    const data = unwrap(
      await this.#link.vfs({ t: "vfs.read", path: wire, offset: 0, length }),
      `reading ${rel}`,
    );
    if (data.t !== "vfs.data") throw new Error("unexpected file response");
    return {
      path: rel,
      contents: Buffer.from(data.dataB64, "base64").toString("utf8"),
      ...(info.entry.sizeBytes > length
        ? { truncated: `file is larger than ${String(READ_LIMIT)} bytes` }
        : {}),
    };
  }

  async writeFile(
    rel: string,
    contents: string,
  ): Promise<{ ok: true; path: string; bytes: number }> {
    const bytes = Buffer.byteLength(contents, "utf8");
    if (bytes > WRITE_LIMIT) throw new Error("file is too large to write");
    const wire = this.#filePath(rel);
    const parent = path.posix.dirname(wire);
    if (parent !== "/") {
      unwrap(
        await this.#link.vfs({ t: "vfs.mkdir", path: parent }),
        "creating parent folder",
      );
    }
    unwrap(
      await this.#link.vfs({
        t: "vfs.write",
        path: wire,
        dataB64: Buffer.from(contents, "utf8").toString("base64"),
      }),
      `writing ${rel}`,
    );
    return { ok: true, path: rel, bytes };
  }

  async editFile(
    rel: string,
    oldText: string,
    newText: string,
  ): Promise<{ ok: true; path: string }> {
    const current = await this.readFile(rel);
    const first = current.contents.indexOf(oldText);
    if (first === -1) throw new Error("oldText was not found");
    if (current.contents.indexOf(oldText, first + 1) !== -1) {
      throw new Error("oldText appears more than once");
    }
    const next = current.contents.replace(oldText, () => newText);
    if (Buffer.byteLength(next, "utf8") > WRITE_LIMIT) {
      throw new Error("edited file is too large");
    }
    unwrap(
      await this.#link.vfs({
        t: "vfs.replace",
        path: this.#filePath(rel),
        expectedDataB64: Buffer.from(current.contents, "utf8").toString("base64"),
        dataB64: Buffer.from(next, "utf8").toString("base64"),
      }),
      `editing ${rel}`,
    );
    return { ok: true, path: rel };
  }

  addMemory(text: string): Promise<{ saved: string }> {
    return this.#withMemoryLock(async () => {
      const clean = text.trim().replace(/\s+/gu, " ");
      if (clean === "" || Buffer.byteLength(clean, "utf8") > 1_024) {
        throw new Error("memory must be 1-1024 bytes");
      }
      const records = await this.#memoryRecords();
      const record: MemoryRecord = {
        id: (records.at(-1)?.id ?? 0) + 1,
        date: new Date().toISOString().slice(0, 10),
        text: clean,
      };
      await this.#appendJson(MEMORY_PATH, record);
      return { saved: formatMemory(record) };
    });
  }

  async searchMemory(query: string): Promise<{ matches: string[]; note?: string }> {
    const clean = query.trim().toLowerCase();
    const matches = (await this.#memoryRecords())
      .filter((record) => formatMemory(record).toLowerCase().includes(clean))
      .slice(-50)
      .map(formatMemory);
    return matches.length === 0
      ? { matches, note: "No match." }
      : { matches };
  }

  async expandMemory(block: string): Promise<{ entries: string[] }> {
    const range = parseBlock(block);
    const records = await this.#memoryRecords();
    return {
      entries: records
        .filter((record) => record.id >= range.lo && record.id <= range.hi)
        .map(formatMemory),
    };
  }

  compressMemory(block: string, summary: string): Promise<{ result: string }> {
    return this.#withMemoryLock(async () => {
      const range = parseBlock(block);
      const clean = summary.trim().replace(/\s+/gu, " ");
      if (clean === "") throw new Error("summary cannot be empty");
      await this.#appendJson(MEMORY_SUMMARY_PATH, {
        block: `${String(range.lo)}-${String(range.hi)}`,
        summary: clean,
        updatedAt: new Date().toISOString(),
      });
      return { result: `Saved summary for #${String(range.lo)}-${String(range.hi)}.` };
    });
  }

  async #spawnShell(): Promise<RemoteShell> {
    if (!this.#link.connected()) throw new Error("the user's computer is offline");
    const shellId = randomUUID();
    const response = await this.#link.ctl({
      t: "pty.spawn",
      ptyId: shellId,
      cols: 120,
      rows: 40,
      command: "/bin/bash --noprofile --norc -i",
      env: { TERM: "xterm-256color", COLORTERM: "truecolor" },
    });
    if (response?.t === "error") throw new Error(response.message);
    const shell: RemoteShell = {
      shellId,
      channel: undefined as unknown as PtyChannel,
      output: "",
      marker: null,
      exitCode: null,
      listeners: new Set<() => void>(),
    };
    shell.channel = this.#link.openPty(shellId, (data) => {
      shell.output = (shell.output + data.toString("utf8")).slice(-OUTPUT_LIMIT);
      const marker = shell.marker;
      if (marker !== null) {
        const match = new RegExp(`${marker}:(-?\\d+)`).exec(shell.output);
        if (match?.[1] !== undefined) shell.exitCode = Number(match[1]);
      }
      this.#notify(shell);
    });
    this.#shells.set(shellId, shell);
    return shell;
  }

  #wait(
    shell: RemoteShell,
    timeoutSeconds: number,
    pattern?: string,
  ): Promise<ComputerRunResult> {
    if (shell.exitCode !== null || (pattern !== undefined && shell.output.includes(pattern))) {
      return Promise.resolve(this.#present(shell));
    }
    return new Promise((resolve) => {
      let settled = false;
      const finish = (timedOut: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        shell.listeners.delete(onChange);
        resolve({ ...this.#present(shell), ...(timedOut ? { timedOut: true } : {}) });
      };
      const onChange = (): void => {
        if (
          shell.exitCode !== null ||
          (pattern !== undefined && shell.output.includes(pattern))
        ) {
          finish(false);
        }
      };
      const timer = setTimeout(() => finish(true), timeoutSeconds * 1_000);
      timer.unref?.();
      shell.listeners.add(onChange);
      onChange();
    });
  }

  #waitForChange(shell: RemoteShell, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        shell.listeners.delete(done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      timer.unref?.();
      shell.listeners.add(done);
    });
  }

  #present(shell: RemoteShell): ComputerRunResult {
    let output = cleanOutput(shell.output);
    if (shell.marker !== null) {
      output = output.replace(new RegExp(`\\n?${shell.marker}:-?\\d+.*$`, "su"), "");
    }
    return { shellId: shell.shellId, output: output.trim(), exitCode: shell.exitCode };
  }

  #notify(shell: RemoteShell): void {
    for (const listener of [...shell.listeners]) listener();
  }

  async #requireShell(shellId: string): Promise<RemoteShell> {
    const existing = this.#shells.get(shellId);
    if (existing !== undefined) return existing;
    if (!this.#link.connected()) throw new Error("the user's computer is offline");
    const shell: RemoteShell = {
      shellId,
      channel: undefined as unknown as PtyChannel,
      output: "",
      marker: null,
      exitCode: null,
      listeners: new Set(),
    };
    shell.channel = this.#link.openPty(shellId, (data) => {
      shell.output = (shell.output + data.toString("utf8")).slice(-OUTPUT_LIMIT);
      this.#notify(shell);
    });
    this.#shells.set(shellId, shell);
    const response = await this.#link.ctl({
      t: "pty.attach",
      ptyId: shellId,
      sinceByte: 0,
      cols: 120,
      rows: 40,
    });
    if (response?.t === "error") {
      shell.channel.close();
      this.#shells.delete(shellId);
      throw new Error(response.message);
    }
    if (response?.t !== "pty.attached") {
      shell.channel.close();
      this.#shells.delete(shellId);
      throw new Error(`unknown shell ${shellId}`);
    }
    await this.#waitForChange(shell, 100);
    return shell;
  }

  #filePath(rel: string): string {
    const clean = normalizeVfsPath(rel === "" ? "/" : rel);
    if (clean === null) throw new Error(`path "${rel}" escapes the workspace`);
    return clean;
  }

  async #memoryRecords(): Promise<MemoryRecord[]> {
    const response = await this.#link.vfs({ t: "vfs.stat", path: MEMORY_PATH });
    if (response.t === "error" && response.code === "vfs_not_found") return [];
    const info = unwrap(response, "reading memory");
    if (info.t !== "vfs.info" || info.entry.sizeBytes === 0) return [];
    const data = unwrap(
      await this.#link.vfs({
        t: "vfs.read",
        path: MEMORY_PATH,
        offset: 0,
        length: info.entry.sizeBytes,
      }),
      "reading memory",
    );
    if (data.t !== "vfs.data") throw new Error("unexpected memory response");
    return Buffer.from(data.dataB64, "base64")
      .toString("utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const parsed = JSON.parse(line) as MemoryRecord;
          return typeof parsed.id === "number" && typeof parsed.text === "string"
            ? [parsed]
            : [];
        } catch {
          return [];
        }
      });
  }

  async #appendJson(file: string, value: unknown): Promise<void> {
    unwrap(
      await this.#link.vfs({ t: "vfs.mkdir", path: "/.suma" }),
      "creating memory folder",
    );
    const dataB64 = Buffer.from(`${JSON.stringify(value)}\n`, "utf8").toString(
      "base64",
    );
    const existing = await this.#link.vfs({ t: "vfs.stat", path: file });
    if (existing.t === "error" && existing.code === "vfs_not_found") {
      unwrap(
        await this.#link.vfs({ t: "vfs.write", path: file, dataB64 }),
        "creating memory",
      );
      return;
    }
    const info = unwrap(existing, "checking memory");
    if (info.t !== "vfs.info" || info.entry.kind !== "file") {
      throw new Error("memory path is not a file");
    }
    unwrap(
      await this.#link.vfs({
        t: "vfs.append",
        path: file,
        dataB64,
        expectedSizeBytes: info.entry.sizeBytes,
      }),
      "saving memory",
    );
  }

  #withMemoryLock<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#memoryTail.then(operation, operation);
    this.#memoryTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function unwrap(
  response: VfsResponse,
  context: string,
): Exclude<VfsResponse, { t: "error" }> {
  if (response.t === "error") throw new Error(`${context}: ${response.message}`);
  return response;
}

function clampTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_TIMEOUT_SECONDS;
  return Math.max(1, Math.min(MAX_TIMEOUT_SECONDS, Math.floor(value)));
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'"'"'`)}'`;
}

function cleanOutput(value: string): string {
  return value
    .replace(ANSI_ESCAPE, "")
    .replace(/\r/gu, "");
}

function formatMemory(record: MemoryRecord): string {
  return `#${String(record.id)} ${record.date} ${record.text}`;
}

function parseBlock(block: string): { lo: number; hi: number } {
  const match = /^(\d+)(?:-(\d+))?$/u.exec(block.trim());
  const lo = Number(match?.[1]);
  const hi = Number(match?.[2] ?? match?.[1]);
  if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < 1 || hi < lo) {
    throw new Error("memory block must look like 1 or 1-16");
  }
  return { lo, hi };
}
