/**
 * SimAgent — LOCAL DEVELOPMENT STAND-IN for suma-agent, used when
 * SUMA_AGENT_URL is unset. The product path (PRD §8.5) is the Rust agent in
 * the user's VM driving real PTYs (portable-pty) over the QUIC mux; this
 * simulator exists only so the terminal/ports UI can be driven end-to-end on
 * a dev Mac with no VM.
 *
 * Shells run on a real PTY via node-pty (same fidelity as the Rust agent's
 * portable-pty — full-screen TUIs render, resize delivers SIGWINCH), so the
 * xterm.js renderer behaves identically in dev and production. When the
 * native module cannot load — plain-Node test runs after an Electron ABI
 * rebuild, worker threads, missing prebuild — spawning falls back to plain
 * child_process pipes with a cooked line discipline (local echo, line
 * buffering, backspace, Ctrl-C) and TERM=dumb; line editing and full-screen
 * programs won't work there, an honest artifact of having no TTY. Attaching
 * to a shell whose process has exited reports "reconstructed" — the same
 * contract a cold-booted VM reports: context (scrollback, cwd) back,
 * process gone.
 */

import {
  execFile,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { mkdirSync, watch as fsWatch, type FSWatcher } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { clearTimeout, setTimeout } from "node:timers";
import type { Duplex } from "node:stream";
import type {
  AgentCtlRequest,
  AgentCtlResponse,
  ListeningPort,
  VfsRequest,
  VfsResponse,
} from "@suma/protocol";
import type { IPty } from "node-pty";
import type { AgentLink, PtyChannel } from "./agent-client";
import { LocalVfs } from "./local-vfs";
import { parseLsofListeners } from "./ports-state";
import { simFetchPublic } from "./sim-fetch";

/** Trailing debounce on watch events — burst writes become one signal. */
const WATCH_DEBOUNCE_MS = 300;

type NodePtyModule = typeof import("node-pty");

/** null = tried and unavailable; undefined = not tried yet. */
let nodePtyModule: NodePtyModule | null | undefined;

async function loadNodePty(): Promise<NodePtyModule | null> {
  if (nodePtyModule !== undefined) return nodePtyModule;
  try {
    // node-pty's native fork is not worker_threads-safe (a crash there is a
    // native abort, not a catchable throw) — vitest thread pools take the
    // pipe fallback instead.
    const { isMainThread } = await import("node:worker_threads");
    nodePtyModule = isMainThread ? await import("node-pty") : null;
  } catch {
    nodePtyModule = null;
  }
  return nodePtyModule;
}

/** Scrollback retained per simulated PTY (bytes, not the PRD's 100k lines —
 *  a byte cap keeps the stand-in simple and bounded). */
export const SIM_SCROLLBACK_MAX_BYTES = 1024 * 1024;

const LSOF_TIMEOUT_MS = 3_000;

interface SimPty {
  ptyId: string;
  /** Real PTY (node-pty); exclusive with `child`. */
  tty: IPty | null;
  /** Pipe-fallback shell; exclusive with `tty`. */
  child: ChildProcessWithoutNullStreams | null;
  exited: boolean;
  exitCode: number | null;
  cwd: string;
  scrollback: Buffer;
  /** Lifetime output count; scrollback may retain only its bounded suffix. */
  totalOutputBytes: number;
  /** Cooked-line buffer — pipe fallback only. */
  pendingLine: string;
  jobMode: boolean;
  listeners: Set<(data: Buffer) => void>;
}

function isLive(pty: SimPty): boolean {
  return !pty.exited && (pty.tty !== null || pty.child !== null);
}

export interface SimAgentOptions {
  /**
   * Where the simulated machine's shared filesystem lives — the sim's
   * `~/cloud`. A provider rather than a value: compute mode is chosen
   * mid-session during onboarding, and the next vfs call (or shell spawn)
   * must land at the newly chosen root without a restart.
   */
  root?: () => string;
  /** False when a local-mode account's computer seat belongs to another Mac. */
  available?: () => boolean;
}

/** The sim's default shared root — the local-mode product folder. */
export function defaultSimRoot(): string {
  return path.join(os.homedir(), "Suma");
}

export class SimAgent implements AgentLink {
  readonly kind = "simulated" as const;

  private readonly ptys = new Map<string, SimPty>();
  private readonly ctlEventListeners = new Set<
    (event: AgentCtlResponse) => void
  >();
  private stopped = false;
  private readonly rootProvider: () => string;
  private readonly availabilityProvider: () => boolean;
  private localVfs: LocalVfs | null = null;
  /** In-flight fetches by fetchId, for fetch.cancel. */
  private readonly activeFetches = new Map<string, AbortController>();
  private watcher: FSWatcher | null = null;
  private watchedRoot: string | null = null;
  private readonly pendingWatchPaths = new Set<string>();
  private watchSawUnnamed = false;
  private watchTimer: NodeJS.Timeout | null = null;

  constructor(options: SimAgentOptions = {}) {
    this.rootProvider = options.root ?? defaultSimRoot;
    this.availabilityProvider = options.available ?? (() => true);
  }

  connected(): boolean {
    return !this.stopped && this.availabilityProvider();
  }

  async vfs(request: VfsRequest): Promise<VfsResponse> {
    this.requireAvailable();
    return this.vfsFor(this.currentRoot()).handle(request);
  }

  vfsRootLabel(): string {
    return this.currentRoot();
  }

  /** The provider is re-read per call so a mode change lands immediately. */
  private currentRoot(): string {
    const root = this.rootProvider();
    try {
      mkdirSync(root, { recursive: true });
    } catch {
      // Surfaces as an honest vfs/spawn error below instead of a crash here.
    }
    this.ensureWatcher(root);
    return root;
  }

  /**
   * Watch the current root for changes and emit debounced `vfs.changed`
   * events — the local twin of the agent's watch.rs, but event-driven:
   * fs.watch(recursive) works on macOS and names the paths. Re-armed when
   * the root provider moves (mode change), silently off when fs.watch
   * itself fails (rare; the explorer still has manual/save refresh).
   */
  private ensureWatcher(root: string): void {
    if (this.stopped || this.watchedRoot === root) return;
    this.watcher?.close();
    this.watcher = null;
    this.watchedRoot = root;
    try {
      const watcher = fsWatch(root, { recursive: true }, (_event, filename) => {
        if (typeof filename === "string" && filename.length > 0) {
          this.pendingWatchPaths.add(`/${filename}`);
        } else {
          this.watchSawUnnamed = true;
        }
        this.armWatchTimer();
      });
      watcher.on("error", () => {
        watcher.close();
        if (this.watcher === watcher) {
          this.watcher = null;
          this.watchedRoot = null; // retried on the next currentRoot()
        }
      });
      this.watcher = watcher;
    } catch {
      this.watcher = null; // watch unavailable — refresh paths still work
    }
  }

  private armWatchTimer(): void {
    if (this.watchTimer !== null) clearTimeout(this.watchTimer);
    this.watchTimer = setTimeout(() => {
      this.watchTimer = null;
      const paths = [...this.pendingWatchPaths];
      const unnamed = this.watchSawUnnamed;
      this.pendingWatchPaths.clear();
      this.watchSawUnnamed = false;
      if (paths.length === 0 && !unnamed) return;
      // >20 distinct paths (or any unnamed event): say only "something
      // changed" — the client re-lists either way, and the smaller frame
      // wins (same rule as the Rust watcher, which never names paths).
      this.emitCtlEvent(
        paths.length > 0 && paths.length <= 20 && !unnamed
          ? { t: "vfs.changed", paths }
          : { t: "vfs.changed" },
      );
    }, WATCH_DEBOUNCE_MS);
    // A pending flush must not keep the process alive.
    this.watchTimer.unref?.();
  }

  private emitCtlEvent(event: AgentCtlResponse): void {
    for (const listener of this.ctlEventListeners) listener(event);
  }

  private vfsFor(root: string): LocalVfs {
    if (this.localVfs === null || this.localVfs.rootDir() !== root) {
      this.localVfs = new LocalVfs(root);
    }
    return this.localVfs;
  }

  onConnectionChanged(): () => void {
    return () => undefined;
  }

  onCtlEvent(listener: (event: AgentCtlResponse) => void): () => void {
    this.ctlEventListeners.add(listener);
    return () => this.ctlEventListeners.delete(listener);
  }

  async ctl(request: AgentCtlRequest): Promise<AgentCtlResponse | null> {
    this.requireAvailable();
    switch (request.t) {
      case "pty.spawn":
        return this.spawnPty(
          request.ptyId,
          request.cwd,
          request.cols,
          request.rows,
          request.env,
        );
      case "pty.attach": {
        const pty = this.ptys.get(request.ptyId);
        if (pty === undefined) {
          return {
            t: "error",
            code: "not_found",
            message: `no pty ${request.ptyId}`,
          };
        }
        // Replay the retained scrollback through the pty channel — after this
        // response settles, so the caller can reset its display first.
        const retainedFrom = Math.max(
          0,
          pty.totalOutputBytes - pty.scrollback.byteLength,
        );
        const requested = Math.max(request.sinceByte ?? 0, retainedFrom);
        const replay = Buffer.from(
          pty.scrollback.subarray(requested - retainedFrom),
        );
        queueMicrotask(() => this.emitData(pty, replay));
        return {
          t: "pty.attached",
          ptyId: pty.ptyId,
          restore: isLive(pty) ? "resumed" : "reconstructed",
          scrollbackBytes: pty.totalOutputBytes,
          cwd: pty.cwd,
        };
      }
      case "pty.resize": {
        const pty = this.ptys.get(request.ptyId);
        if (pty !== undefined && pty.tty !== null && !pty.exited) {
          try {
            pty.tty.resize(request.cols, request.rows); // TIOCSWINSZ → SIGWINCH
          } catch {
            // Raced the shell's exit — the exit handler owns cleanup.
          }
        }
        // Pipe fallback has no window size; spawn-time COLUMNS/LINES is all
        // that path can offer.
        return null;
      }
      case "pty.kill": {
        const pty = this.ptys.get(request.ptyId);
        const signal =
          request.signal === "KILL"
            ? "SIGKILL"
            : request.signal === "INT"
              ? "SIGINT"
              : "SIGTERM";
        try {
          pty?.tty?.kill(signal);
        } catch {
          // Already exited.
        }
        pty?.child?.kill(signal);
        return null;
      }
      case "job.set": {
        const pty = this.ptys.get(request.ptyId);
        if (pty === undefined) {
          return {
            t: "error",
            code: "not_found",
            message: `no pty ${request.ptyId}`,
          };
        }
        pty.jobMode = request.enabled;
        return { t: "job.ack", ptyId: pty.ptyId, enabled: request.enabled };
      }
      case "pty.list":
        // Same contract as the Rust agent: live sessions and dead-but-
        // retained ones, sorted by ptyId. The simulator has no on-disk
        // persistence, so "persisted context" means an exited SimPty whose
        // scrollback this process still holds.
        return {
          t: "pty.listing",
          sessions: [...this.ptys.values()]
            .map((pty) => ({
              ptyId: pty.ptyId,
              cwd: pty.cwd,
              live: isLive(pty),
            }))
            .sort((a, b) => a.ptyId.localeCompare(b.ptyId)),
        };
      case "ports.list":
        return { t: "ports", ports: await this.listPorts() };
      case "fetch.public": {
        // Same contract as the Rust agent post-pump: `fetch.started` is the
        // terminal response, the download runs detached, and everything
        // after arrives as unsolicited ctl events correlated by url.
        const resolved = await this.vfsFor(this.currentRoot()).resolveNewFile(
          request.destPath,
        );
        if ("refused" in resolved) {
          return {
            t: "error",
            code: "vfs_path_refused",
            message: resolved.refused,
          };
        }
        if (this.activeFetches.has(request.fetchId)) {
          return {
            t: "error",
            code: "fetch_exists",
            message: `fetch ${request.fetchId} is already active`,
          };
        }
        const controller = new AbortController();
        this.activeFetches.set(request.fetchId, controller);
        const fetchId = request.fetchId;
        void simFetchPublic({
          fetchId,
          url: request.url,
          destTarget: resolved.target,
          destWirePath: resolved.path,
          signal: controller.signal,
          emit: (event) => this.emitCtlEvent(event),
        }).finally(() => {
          // Only clear if this is still the same fetch (a re-used id after
          // settle would have replaced the entry).
          if (this.activeFetches.get(fetchId) === controller) {
            this.activeFetches.delete(fetchId);
          }
        });
        return {
          t: "fetch.started",
          fetchId: request.fetchId,
          url: request.url,
          path: resolved.path,
        };
      }
      case "fetch.cancel": {
        // Fire-and-forget: abort the download if it's ours; the
        // fetch.failed(cancelled) event confirms. Unknown ids are no-ops.
        this.activeFetches.get(request.fetchId)?.abort();
        return null;
      }
    }
  }

  openPty(ptyId: string, onData: (data: Buffer) => void): PtyChannel {
    if (!this.connected()) {
      return { write: () => undefined, close: () => undefined };
    }
    const pty = this.ptys.get(ptyId);
    if (pty === undefined) {
      return { write: () => undefined, close: () => undefined };
    }
    pty.listeners.add(onData);
    return {
      write: (data) => this.handleInput(pty, data),
      close: () => pty.listeners.delete(onData),
    };
  }

  forward(port: number, local: Duplex): void {
    if (!this.connected()) {
      local.destroy(
        new Error("this account's computer belongs to another Mac"),
      );
      return;
    }
    // The simulated "VM" is this Mac, so fwd/<port> is a loopback pipe.
    const socket = net.connect(port, "127.0.0.1");
    socket.pipe(local);
    local.pipe(socket);
    const closeBoth = (): void => {
      socket.destroy();
      local.destroy();
    };
    socket.on("error", closeBoth);
    local.on("error", closeBoth);
    socket.on("close", closeBoth);
    local.on("close", closeBoth);
  }

  stop(): void {
    this.stopped = true;
    this.watcher?.close();
    this.watcher = null;
    if (this.watchTimer !== null) {
      clearTimeout(this.watchTimer);
      this.watchTimer = null;
    }
    for (const pty of this.ptys.values()) {
      try {
        pty.tty?.kill("SIGTERM");
      } catch {
        // Already exited.
      }
      pty.child?.kill("SIGTERM");
    }
  }

  /* ------------------------------ internals ------------------------------ */

  private requireAvailable(): void {
    if (!this.connected()) {
      throw new Error("this account's computer belongs to another Mac");
    }
  }

  private async spawnPty(
    ptyId: string,
    cwd: string | undefined,
    cols: number,
    rows: number,
    env?: Record<string, string>,
  ): Promise<AgentCtlResponse> {
    if (this.ptys.has(ptyId)) {
      return {
        t: "error",
        code: "exists",
        message: `pty ${ptyId} already exists`,
      };
    }
    const shell = process.env["SHELL"] ?? "/bin/sh";
    // Shells land in the shared root by default — the same tree the explorer
    // shows — mirroring the Rust agent's `$HOME/cloud` default.
    const dir = cwd ?? this.currentRoot();
    const pty: SimPty = {
      ptyId,
      tty: null,
      child: null,
      exited: false,
      exitCode: null,
      cwd: dir,
      scrollback: Buffer.alloc(0),
      totalOutputBytes: 0,
      pendingLine: "",
      jobMode: false,
      listeners: new Set(),
    };

    const nodePty = await loadNodePty();
    if (nodePty !== null) {
      try {
        const tty = nodePty.spawn(shell, [], {
          name: "xterm-256color",
          cols,
          rows,
          cwd: dir,
          env: {
            ...(process.env as Record<string, string>),
            TERM: "xterm-256color",
            ...env,
          },
        });
        pty.tty = tty;
        this.ptys.set(ptyId, pty);
        tty.onData((data) => this.emitOutput(pty, Buffer.from(data)));
        tty.onExit(({ exitCode }) => this.onShellExit(pty, exitCode));
        return { t: "pty.spawned", ptyId };
      } catch {
        // Native spawn failed (missing helper, sandbox) — pipes below.
      }
    }

    return this.spawnPipeFallback(pty, shell, cols, rows);
  }

  private spawnPipeFallback(
    pty: SimPty,
    shell: string,
    cols: number,
    rows: number,
  ): AgentCtlResponse {
    const dir = pty.cwd;
    // -i so the shell prints prompts to the pipe; job control is unavailable
    // without a TTY and the shell will say so once — an honest artifact.
    //
    // `detached` puts the shell in its own session with NO controlling
    // terminal, and that is load-bearing rather than hygiene. An interactive
    // zsh drives its line editor from the controlling terminal, not from
    // stdin: when Suma is started from a shell (`pnpm dev`), the child
    // inherits that terminal, fails its first read from it with
    // "zsh: error on TTY read: Input/output error", and exits(1) before
    // printing a prompt — while the same code works when Suma is launched
    // with no terminal attached. Detaching makes both launch paths behave the
    // same: with no controlling terminal to reach for, the shell falls back to
    // the stdin pipe this stand-in actually provides.
    const child = spawn(shell, ["-i"], {
      cwd: dir,
      env: {
        ...process.env,
        TERM: "dumb", // pipes are not a TTY — claiming xterm would be a lie
        COLUMNS: String(cols),
        LINES: String(rows),
      },
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    pty.child = child;
    this.ptys.set(pty.ptyId, pty);
    const onOutput = (chunk: Buffer): void => this.emitOutput(pty, chunk);
    child.stdout.on("data", onOutput);
    child.stderr.on("data", onOutput);
    // A write racing the shell's exit must not take the app down with EPIPE.
    child.stdin.on("error", () => undefined);
    child.on("error", (err) => {
      this.emitOutput(
        pty,
        Buffer.from(`\r\n[suma sim] shell failed: ${err.message}\r\n`),
      );
    });
    child.on("exit", (code) => this.onShellExit(pty, code));
    return { t: "pty.spawned", ptyId: pty.ptyId };
  }

  private onShellExit(pty: SimPty, code: number | null): void {
    pty.exited = true;
    pty.exitCode = code;
    pty.tty = null;
    pty.child = null;
    if (!this.stopped) {
      this.emitOutput(
        pty,
        Buffer.from(
          `\r\n[process exited${code === null ? "" : ` (${code})`}]\r\n`,
        ),
      );
      const event: AgentCtlResponse = {
        t: "pty.exited",
        ptyId: pty.ptyId,
        code: code ?? -1,
      };
      for (const listener of this.ctlEventListeners) listener(event);
    }
  }

  /** Real PTY: bytes through verbatim — the kernel line discipline is the
   *  line discipline. Pipe fallback: cooked emulation (echo, line buffer). */
  private handleInput(pty: SimPty, data: string): void {
    if (pty.tty !== null) {
      pty.tty.write(data);
      return;
    }
    for (const ch of data) {
      if (ch === "\r" || ch === "\n") {
        this.emitOutput(pty, Buffer.from("\r\n"));
        pty.child?.stdin.write(`${pty.pendingLine}\n`);
        pty.pendingLine = "";
      } else if (ch === "\x7f" || ch === "\b") {
        if (pty.pendingLine.length > 0) {
          pty.pendingLine = pty.pendingLine.slice(0, -1);
          this.emitOutput(pty, Buffer.from("\b \b"));
        }
      } else if (ch === "\x03") {
        pty.pendingLine = "";
        this.emitOutput(pty, Buffer.from("^C\r\n"));
        pty.child?.kill("SIGINT");
      } else if (ch === "\x04") {
        pty.child?.stdin.end();
      } else if (ch >= " ") {
        pty.pendingLine += ch;
        this.emitOutput(pty, Buffer.from(ch));
      }
      // Other control sequences (arrows, etc.) need a real PTY — dropped here.
    }
  }

  private emitOutput(pty: SimPty, chunk: Buffer): void {
    pty.totalOutputBytes += chunk.byteLength;
    pty.scrollback = Buffer.concat([pty.scrollback, chunk]);
    if (pty.scrollback.byteLength > SIM_SCROLLBACK_MAX_BYTES) {
      pty.scrollback = pty.scrollback.subarray(
        pty.scrollback.byteLength - SIM_SCROLLBACK_MAX_BYTES,
      );
    }
    this.emitData(pty, chunk);
  }

  private emitData(pty: SimPty, chunk: Buffer): void {
    for (const listener of pty.listeners) listener(chunk);
  }

  private listPorts(): Promise<ListeningPort[]> {
    return new Promise((resolve) => {
      execFile(
        "lsof",
        ["-nP", "-iTCP", "-sTCP:LISTEN"],
        { timeout: LSOF_TIMEOUT_MS },
        (err, stdout) => {
          // lsof exits 1 when nothing matches; any failure just means "no ports".
          resolve(
            err !== null && stdout.length === 0
              ? []
              : parseLsofListeners(stdout),
          );
        },
      );
    });
  }
}
