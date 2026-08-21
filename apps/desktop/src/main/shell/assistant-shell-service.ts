/**
 * AssistantShellService — the assistant's hands on the computer.
 *
 * Runs commands, drives interactive terminal programs (Claude Code and the
 * like), and reports dev-server ports, all through the SAME TerminalService
 * the user's terminal panel uses — so every shell the assistant opens is
 * visible, attachable, and killable by the user. Completion is detected with
 * the job protocol in assistant-shell-core.ts (script over the vfs + nonce
 * sentinel), read off a per-shell headless terminal model fed by
 * TerminalService.subscribe.
 *
 * Bound to the live services after the graph is built (index.ts), the same
 * late-bind MemoryService/WorkspaceFsService use — the agent link does not
 * exist when ChatService is constructed. Every operation is best-effort
 * against whatever computer the link currently reaches (local sim / cloud VM
 * / relayed home Mac) and degrades to a recoverable error when it is not.
 */

import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import type { VfsRequest, VfsResponse } from "@suma/protocol";
import type { AgentLink } from "../compute/agent-client";
import type { PortsService } from "../compute/ports-service";
import type {
  TerminalService,
  TerminalTapEvent,
} from "../compute/terminal-service";
import type { PortForwardInfo, TerminalInfo } from "../../shared/ipc";
import {
  cleanOutput,
  extractJobOutput,
  JOBS_DIR,
  joinShellPath,
  planJob,
  resolveSendKeys,
  sentinelIn,
} from "./assistant-shell-core";
import { TerminalScreen } from "./terminal-screen";

const DEFAULT_TIMEOUT_SECONDS = 120;
const MAX_TIMEOUT_SECONDS = 600;
/** Foreground shells are fungible (each command sets its own cwd), so a small
 *  pool lets parallel run_command calls proceed without queueing behind a
 *  long build. Background/interactive shells are dedicated and uncounted here. */
const FOREGROUND_POOL_MAX = 3;
/** Total assistant shells across all purposes — a runaway backstop. */
const TOTAL_SHELL_CAP = 8;
/** How long to let output settle after typed input before reading back. */
const SETTLE_MS = 700;
/** Grace between SIGINT and hard close in killShell. */
const KILL_GRACE_MS = 400;
/** Job scripts older than this are swept on bind (crash leftovers). */
const STALE_JOB_MS = 24 * 60 * 60 * 1000;
/**
 * Start assistant PTYs as a clean Bash instead of the user's regular login
 * shell. The outer shell expands only this allowlist, then `env -i` and
 * `exec` ensure neither the desktop's dotenv credentials nor the agent
 * process's service credentials survive into model-driven commands. Startup
 * files stay disabled for the same reason.
 */
const CLEAN_SHELL_COMMAND =
  'exec /usr/bin/env -i HOME="$HOME" PATH="$PATH" USER="$USER" ' +
  'LOGNAME="$LOGNAME" LANG="$LANG" TMPDIR="$TMPDIR" ' +
  "TERM=xterm-256color COLORTERM=true SHELL=/bin/bash " +
  "/bin/bash --noprofile --norc -i";

export interface AssistantShellDeps {
  terminals: TerminalService;
  link: AgentLink;
  ports: PortsService;
  /** Shell-side root path ("~/cloud" on the VM, the sim root locally) — where
   *  vfs "/…" paths live on the machine, for turning job-script vfs paths into
   *  shell paths. Both agents expand a leading ~. */
  shellWorkspaceRoot: () => string;
  /** The active space's folder as a shell path — the same closure
   *  TerminalService uses for a new shell's cwd. null ⇒ the agent's default. */
  defaultCwd: () => Promise<string | null>;
}

export type ShellPurpose = "task" | "background" | "interactive";

interface Shell {
  shellId: string;
  purpose: ShellPurpose;
  screen: TerminalScreen;
  unsubscribe: () => void;
  busy: boolean;
  exited: boolean;
  /** False for timed-out/background jobs: their shellId remains a stable
   * handle for wait_for_output and can never be silently reassigned. */
  reusable: boolean;
  job: ShellJob | null;
  /** Resolvers waiting on this shell's stream (sentinel or timeout). */
  waiters: Set<(text: string) => void>;
}

interface ShellJob {
  jobId: string;
  nonce: string;
  started: number;
  cmdVfsPath: string;
  ctlVfsPath: string;
  /** Explicit background jobs deliberately outlive a stopped chat turn. */
  background: boolean;
  /** True once run_command returned before completion. */
  detached: boolean;
  result: RunResult | null;
  abortSignal?: AbortSignal;
  abortListener?: () => void;
}

export interface RunResult {
  shellId: string;
  output: string;
  truncated: boolean;
  /** null ⇒ still running (timed out or background). */
  exitCode: number | null;
  timedOut?: boolean;
  durationMs: number;
}

function clampTimeout(seconds: number | undefined): number {
  if (seconds === undefined || !Number.isFinite(seconds)) {
    return DEFAULT_TIMEOUT_SECONDS;
  }
  return Math.max(1, Math.min(MAX_TIMEOUT_SECONDS, Math.floor(seconds)));
}

export class AssistantShellService {
  private deps: AssistantShellDeps | null = null;
  private readonly shells = new Map<string, Shell>();
  /** Shell selection + creation is one critical section. AI SDK tool calls
   * execute in parallel, so a plain `find(idle); await; busy=true` can hand
   * the same PTY to multiple commands and race the shell caps. */
  private allocationTail: Promise<void> = Promise.resolve();
  private counter = 0;

  bind(deps: AssistantShellDeps): void {
    this.deps = deps;
    // A link swap drops open pty channels; abandon shells bound to the old
    // link so the next run spawns fresh, and wake any pending waiters.
    deps.link.onConnectionChanged((up) => {
      if (!up) this.invalidateAll("the computer connection changed");
    });
    void this.sweepStaleJobs();
  }

  available(): boolean {
    return this.deps !== null && this.deps.link.connected();
  }

  private require(): AssistantShellDeps {
    if (this.deps === null || !this.deps.link.connected()) {
      throw new Error(
        "no computer is connected right now — it may be waking or offline; try again shortly",
      );
    }
    return this.deps;
  }

  /* ------------------------------- vfs I/O ------------------------------- */

  private async vfs(request: VfsRequest): Promise<VfsResponse> {
    return this.require().link.vfs(request);
  }

  private async writeScript(path: string, contents: string): Promise<void> {
    const mkdir = await this.vfs({ t: "vfs.mkdir", path: JOBS_DIR });
    if (mkdir.t === "error") {
      throw new Error(`preparing the job folder: ${mkdir.message}`);
    }
    const wrote = await this.vfs({
      t: "vfs.write",
      path,
      dataB64: Buffer.from(contents, "utf8").toString("base64"),
    });
    if (wrote.t === "error") {
      throw new Error(`writing the job script: ${wrote.message}`);
    }
  }

  /* ------------------------------- shells -------------------------------- */

  private titleFor(purpose: ShellPurpose): string {
    return purpose === "background"
      ? "Assistant (server)"
      : purpose === "interactive"
        ? "Assistant (app)"
        : "Assistant";
  }

  /** Call only while holding withAllocationLock. */
  private async spawnShell(purpose: ShellPurpose): Promise<Shell> {
    const deps = this.require();
    const live = [...this.shells.values()].filter((s) => !s.exited);
    if (live.length >= TOTAL_SHELL_CAP) {
      throw new Error(
        `too many active shells (${live.length}); stop one with kill_shell before starting another`,
      );
    }
    let cwd: string | undefined;
    try {
      cwd = (await deps.defaultCwd()) ?? undefined;
    } catch {
      cwd = undefined;
    }
    const info: TerminalInfo = await deps.terminals.create(
      cwd,
      this.titleFor(purpose),
      CLEAN_SHELL_COMMAND,
    );
    const screen = new TerminalScreen();
    const shell: Shell = {
      shellId: info.ptyId,
      purpose,
      screen,
      busy: false,
      exited: false,
      reusable: purpose === "task",
      job: null,
      waiters: new Set(),
      unsubscribe: () => undefined,
    };
    shell.unsubscribe = deps.terminals.subscribe(info.ptyId, (event) =>
      this.onTap(shell, event),
    );
    this.shells.set(info.ptyId, shell);
    return shell;
  }

  private onTap(shell: Shell, event: TerminalTapEvent): void {
    let exitCode: number | undefined;
    switch (event.kind) {
      case "data":
        shell.screen.write(event.text);
        break;
      case "reset":
        shell.screen.reset();
        return;
      case "resize":
        shell.screen.resize(event.cols, event.rows);
        return;
      case "exited":
        shell.exited = true;
        exitCode = event.code;
        break;
    }
    // Wake waiters after the write is parsed so they read a current model.
    void shell.screen.flush().then(() => {
      if (this.shells.get(shell.shellId) !== shell) return;
      this.finishJobFromScreen(shell, exitCode);
      const text = shell.screen.tailText(4000);
      for (const waiter of [...shell.waiters]) waiter(text);
    });
  }

  private async withAllocationLock<T>(op: () => Promise<T>): Promise<T> {
    const previous = this.allocationTail;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.allocationTail = previous.then(() => gate);
    await previous;
    try {
      return await op();
    } finally {
      release();
    }
  }

  /** Atomically reserve an idle foreground shell or create one under cap. */
  private async acquireRunShell(
    background: boolean,
    signal?: AbortSignal,
  ): Promise<Shell> {
    return this.withAllocationLock(async () => {
      this.throwIfAborted(signal);
      if (!background) {
        const idle = [...this.shells.values()].find(
          (shell) =>
            shell.purpose === "task" &&
            shell.reusable &&
            !shell.busy &&
            !shell.exited,
        );
        if (idle !== undefined) {
          idle.busy = true;
          return idle;
        }
        const poolSize = [...this.shells.values()].filter(
          (shell) =>
            shell.purpose === "task" && shell.reusable && !shell.exited,
        ).length;
        if (poolSize >= FOREGROUND_POOL_MAX) {
          throw new Error(
            `all ${FOREGROUND_POOL_MAX} assistant command shells are busy; wait for one to finish`,
          );
        }
      }
      const shell = await this.spawnShell(background ? "background" : "task");
      try {
        this.throwIfAborted(signal);
      } catch (error) {
        await this.discardNewShell(shell);
        throw error;
      }
      shell.busy = true;
      return shell;
    });
  }

  private async acquireInteractiveShell(signal?: AbortSignal): Promise<Shell> {
    return this.withAllocationLock(async () => {
      this.throwIfAborted(signal);
      const shell = await this.spawnShell("interactive");
      try {
        this.throwIfAborted(signal);
      } catch (error) {
        await this.discardNewShell(shell);
        throw error;
      }
      return shell;
    });
  }

  private async discardNewShell(shell: Shell): Promise<void> {
    await this.deps?.terminals.close(shell.shellId).catch(() => undefined);
    if (this.shells.get(shell.shellId) === shell) this.disposeShell(shell);
  }

  private async resolveCwd(
    deps: AssistantShellDeps,
    cwd?: string,
  ): Promise<string> {
    if (cwd !== undefined && cwd.trim() !== "") {
      // A relative cwd is resolved against the workspace root; an absolute or
      // ~-path is taken as-is. Traversal above the root is refused.
      if (cwd.startsWith("/") || cwd.startsWith("~")) return cwd;
      if (cwd.split("/").includes("..")) {
        throw new Error(`cwd "${cwd}" must stay inside your workspace`);
      }
      return joinShellPath(deps.shellWorkspaceRoot(), cwd);
    }
    const fromSpace = await deps.defaultCwd().catch(() => null);
    return fromSpace ?? deps.shellWorkspaceRoot();
  }

  /* -------------------------------- run ---------------------------------- */

  async run(
    opts: {
      command: string;
      cwd?: string;
      background?: boolean;
      timeoutSeconds?: number;
    },
    signal?: AbortSignal,
  ): Promise<RunResult> {
    const deps = this.require();
    const command = opts.command.trim();
    if (command === "") throw new Error("command is empty");
    this.throwIfAborted(signal);

    const background = opts.background === true;
    const shell = await this.acquireRunShell(background, signal);
    const started = Date.now();
    let job: ShellJob | null = null;
    let launched = false;
    try {
      const nonce = randomBytes(4).toString("hex");
      const jobId = `${started}-${nonce}`;
      const absCwd = await this.resolveCwd(deps, opts.cwd);
      const plan = planJob(
        command,
        absCwd,
        deps.shellWorkspaceRoot(),
        jobId,
        nonce,
      );
      await this.writeScript(plan.cmdVfsPath, plan.cmdScript);
      await this.writeScript(plan.ctlVfsPath, plan.ctlScript);
      this.throwIfAborted(signal);

      job = {
        jobId,
        nonce,
        started,
        cmdVfsPath: plan.cmdVfsPath,
        ctlVfsPath: plan.ctlVfsPath,
        background,
        detached: background,
        result: null,
      };
      shell.job = job;
      if (!background && signal !== undefined) {
        const abortListener = (): void => {
          void this.killShell(shell.shellId).catch(() => undefined);
        };
        job.abortSignal = signal;
        job.abortListener = abortListener;
        signal.addEventListener("abort", abortListener, { once: true });
      }
      this.throwIfAborted(signal);

      shell.screen.reset();
      deps.terminals.input(shell.shellId, plan.typedLine);
      launched = true;

      if (background) {
        // Give a server a beat to bind. A short-lived background command may
        // already have printed its sentinel; return that honest completion
        // instead of claiming it is still running. Once launched, an explicit
        // background job is detached by request and survives a stopped turn.
        await this.delay(1500);
        if (job.result !== null) return job.result;
        await shell.screen.flush();
        const output = shell.screen.tailText(200);
        const cleaned = cleanOutput(output);
        return {
          shellId: shell.shellId,
          output: cleaned.text,
          truncated: cleaned.truncated,
          exitCode: null,
          durationMs: Date.now() - started,
        };
      }

      const result = await this.awaitJob(
        shell,
        job,
        clampTimeout(opts.timeoutSeconds),
        signal,
      );
      if (result.timedOut === true) {
        // shellId is now a stable handle for wait_for_output. Never put this
        // PTY back in the fungible foreground pool, even after it completes.
        job.detached = true;
        shell.reusable = false;
        if (job.result !== null) shell.busy = false;
        return result;
      }
      this.releaseJob(shell, job);
      return result;
    } catch (error) {
      if (launched) {
        await this.killShell(shell.shellId).catch(() => undefined);
      } else {
        if (job !== null) this.clearJobAbort(job);
        if (shell.job === job) shell.job = null;
        shell.busy = false;
      }
      throw error;
    }
  }

  private awaitJob(
    shell: Shell,
    job: ShellJob,
    timeoutSeconds: number,
    signal?: AbortSignal,
  ): Promise<RunResult> {
    return new Promise<RunResult>((resolve, reject) => {
      let done = false;
      let timer: NodeJS.Timeout | null = null;
      const abortListener = (): void => {
        finishError(this.abortReason(signal));
      };
      const cleanup = (): void => {
        shell.waiters.delete(waiter);
        if (timer !== null) clearTimeout(timer);
        signal?.removeEventListener("abort", abortListener);
      };
      const finish = (result: RunResult): void => {
        if (done) return;
        done = true;
        cleanup();
        resolve(result);
      };
      const finishError = (error: Error): void => {
        if (done) return;
        done = true;
        cleanup();
        reject(error);
      };
      const waiter = (): void => {
        if (job.result !== null) finish(job.result);
      };
      shell.waiters.add(waiter);
      timer = setTimeout(
        () => finish(this.buildJobResult(shell, job, null, true)),
        timeoutSeconds * 1000,
      );
      signal?.addEventListener("abort", abortListener, { once: true });
      if (signal?.aborted === true) {
        abortListener();
        return;
      }
      // Fire once against whatever is already on screen (fast commands may
      // finish before the first tap after we attached this waiter).
      void shell.screen.flush().then(() => {
        this.finishJobFromScreen(shell);
        waiter();
      });
    });
  }

  private buildJobResult(
    shell: Shell,
    job: ShellJob,
    exitCode: number | null,
    timedOut = false,
  ): RunResult {
    const cleaned = cleanOutput(
      extractJobOutput(shell.screen.tailText(4000), job.jobId, job.nonce),
    );
    return {
      shellId: shell.shellId,
      output: cleaned.text,
      truncated: cleaned.truncated,
      exitCode,
      ...(timedOut ? { timedOut: true } : {}),
      durationMs: Date.now() - job.started,
    };
  }

  private finishJobFromScreen(shell: Shell, shellExitCode?: number): void {
    const job = shell.job;
    if (job === null || job.result !== null) return;
    const hit = sentinelIn(shell.screen.tailText(4000), job.nonce);
    if (hit !== null) {
      this.finishJob(shell, job, hit.exitCode);
    } else if (shellExitCode !== undefined || shell.exited) {
      this.finishJob(shell, job, shellExitCode ?? null);
    }
  }

  private finishJob(
    shell: Shell,
    job: ShellJob,
    exitCode: number | null,
  ): void {
    if (shell.job !== job || job.result !== null) return;
    job.result = this.buildJobResult(shell, job, exitCode);
    this.clearJobAbort(job);
    void this.cleanupJob(job.cmdVfsPath, job.ctlVfsPath);
    if (job.detached) shell.busy = false;
  }

  private releaseJob(shell: Shell, job: ShellJob): void {
    if (shell.job !== job) return;
    this.clearJobAbort(job);
    shell.job = null;
    shell.busy = false;
  }

  private clearJobAbort(job: ShellJob): void {
    if (job.abortSignal !== undefined && job.abortListener !== undefined) {
      job.abortSignal.removeEventListener("abort", job.abortListener);
    }
    delete job.abortSignal;
    delete job.abortListener;
  }

  async waitForOutput(
    shellId: string,
    opts: { timeoutSeconds?: number; pattern?: string },
    signal?: AbortSignal,
  ): Promise<RunResult | { shellId: string; output: string; running: true }> {
    const shell = this.requireShell(shellId);
    this.throwIfAborted(signal);
    const timeoutSeconds = clampTimeout(opts.timeoutSeconds);
    const pattern =
      opts.pattern !== undefined && opts.pattern !== "" ? opts.pattern : null;
    const started = Date.now();
    return new Promise((resolve, reject) => {
      let done = false;
      let timer: NodeJS.Timeout | null = null;
      const abortListener = (): void => {
        const job = shell.job;
        if (job !== null && !job.background && job.result === null) {
          void this.killShell(shellId).catch(() => undefined);
        }
        finishError(this.abortReason(signal));
      };
      const cleanup = (): void => {
        shell.waiters.delete(waiter);
        if (timer !== null) clearTimeout(timer);
        signal?.removeEventListener("abort", abortListener);
      };
      const finish = (
        value: RunResult | { shellId: string; output: string; running: true },
      ): void => {
        if (done) return;
        done = true;
        cleanup();
        resolve(value);
      };
      const finishError = (error: Error): void => {
        if (done) return;
        done = true;
        cleanup();
        reject(error);
      };
      const waiter = (text: string): void => {
        const job = shell.job;
        if (job !== null && job.result !== null) {
          finish(job.result);
        } else if (pattern !== null && text.includes(pattern)) {
          const cleaned = cleanOutput(shell.screen.tailText(200));
          finish({ shellId, output: cleaned.text, running: true });
        } else if (shell.exited) {
          const cleaned = cleanOutput(shell.screen.tailText(400));
          finish({
            shellId,
            output: cleaned.text,
            truncated: cleaned.truncated,
            exitCode: null,
            durationMs: Date.now() - started,
          });
        }
      };
      shell.waiters.add(waiter);
      timer = setTimeout(() => {
        const cleaned = cleanOutput(shell.screen.tailText(200));
        finish({ shellId, output: cleaned.text, running: true });
      }, timeoutSeconds * 1000);
      signal?.addEventListener("abort", abortListener, { once: true });
      if (signal?.aborted === true) {
        abortListener();
        return;
      }
      void shell.screen.flush().then(() => waiter(shell.screen.tailText(4000)));
    });
  }

  readTerminal(
    shellId: string,
    mode: "screen" | "tail" = "screen",
    lines = 200,
  ): { text: string; running: boolean } {
    const shell = this.requireShell(shellId);
    const raw =
      mode === "screen"
        ? shell.screen.screenText()
        : shell.screen.tailText(lines);
    return {
      text: cleanOutput(raw).text,
      running: shell.job === null ? !shell.exited : shell.job.result === null,
    };
  }

  async sendKeys(
    shellId: string,
    text?: string,
    keys?: string[],
    signal?: AbortSignal,
  ): Promise<{ screen: string }> {
    const deps = this.require();
    const shell = this.requireShell(shellId);
    this.throwIfAborted(signal);
    let payload = text ?? "";
    if (keys !== undefined && keys.length > 0) payload += resolveSendKeys(keys);
    if (payload === "") throw new Error("send_keys needs text or keys");
    deps.terminals.input(shellId, payload);
    await this.abortableDelay(SETTLE_MS, signal);
    await shell.screen.flush();
    return { screen: cleanOutput(shell.screen.screenText()).text };
  }

  async openInteractive(
    command?: string,
    signal?: AbortSignal,
  ): Promise<{ shellId: string; screen: string }> {
    const deps = this.require();
    const shell = await this.acquireInteractiveShell(signal);
    try {
      if (command !== undefined && command.trim() !== "") {
        if (/[\n\r]/u.test(command)) {
          throw new Error("open_terminal_app takes a single-line command");
        }
        deps.terminals.input(shell.shellId, `${command.trim()}\r`);
        await this.abortableDelay(SETTLE_MS, signal);
      }
      await shell.screen.flush();
      return {
        shellId: shell.shellId,
        screen: cleanOutput(shell.screen.screenText()).text,
      };
    } catch (error) {
      await this.killShell(shell.shellId).catch(() => undefined);
      throw error;
    }
  }

  async killShell(shellId: string): Promise<void> {
    const deps = this.require();
    const shell = this.shells.get(shellId);
    if (shell === undefined) return;
    // Interrupt a foreground job first, then close the pty (kills the tree).
    try {
      deps.terminals.input(shellId, "\x03");
      await this.delay(KILL_GRACE_MS);
    } catch {
      // fall through to close
    }
    await deps.terminals.close(shellId).catch(() => undefined);
    if (this.shells.get(shellId) === shell) this.disposeShell(shell);
  }

  async listPorts(): Promise<PortForwardInfo[]> {
    return this.require().ports.refresh();
  }

  listShells(): Array<{
    shellId: string;
    purpose: ShellPurpose;
    busy: boolean;
    exited: boolean;
  }> {
    return [...this.shells.values()].map((s) => ({
      shellId: s.shellId,
      purpose: s.purpose,
      busy: s.busy,
      exited: s.exited,
    }));
  }

  stopAll(): void {
    for (const shell of [...this.shells.values()]) {
      this.disposeShell(shell);
      this.deps?.terminals.close(shell.shellId).catch(() => undefined);
    }
  }

  /* ------------------------------ internals ------------------------------ */

  private requireShell(shellId: string): Shell {
    const shell = this.shells.get(shellId);
    if (shell === undefined) {
      throw new Error(
        `unknown shell "${shellId}" — it may have been closed; start a new command`,
      );
    }
    return shell;
  }

  private disposeShell(shell: Shell): void {
    if (this.shells.get(shell.shellId) !== shell) return;
    shell.exited = true;
    this.finishJobFromScreen(shell, -1);
    const text = shell.screen.tailText(4000);
    for (const waiter of [...shell.waiters]) waiter(text);
    shell.waiters.clear();
    shell.unsubscribe();
    this.shells.delete(shell.shellId);
    shell.screen.dispose();
  }

  private invalidateAll(reason: string): void {
    for (const shell of [...this.shells.values()]) {
      shell.exited = true;
      this.finishJobFromScreen(shell, -1);
      for (const waiter of [...shell.waiters])
        waiter(shell.screen.tailText(4000));
      shell.waiters.clear();
      shell.unsubscribe();
      shell.screen.dispose();
    }
    this.shells.clear();
    void reason;
  }

  private async cleanupJob(...paths: string[]): Promise<void> {
    for (const path of paths) {
      await this.vfs({ t: "vfs.delete", path }).catch(() => undefined);
    }
  }

  private async sweepStaleJobs(): Promise<void> {
    if (this.deps === null) return;
    const listing = await this.vfs({ t: "vfs.list", path: JOBS_DIR }).catch(
      () => null,
    );
    if (listing === null || listing.t !== "vfs.listing") return;
    const cutoff = Date.now() - STALE_JOB_MS;
    for (const entry of listing.entries) {
      if (entry.modifiedAtMs < cutoff) {
        await this.vfs({ t: "vfs.delete", path: entry.path }).catch(
          () => undefined,
        );
      }
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal === undefined) return this.delay(ms);
    this.throwIfAborted(signal);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = (): void => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        reject(this.abortReason(signal));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted === true) throw this.abortReason(signal);
  }

  private abortReason(signal?: AbortSignal): Error {
    return signal?.reason instanceof Error
      ? signal.reason
      : new Error("assistant operation aborted");
  }
}
