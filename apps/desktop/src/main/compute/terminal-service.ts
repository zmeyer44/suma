/**
 * TerminalService — the terminal:* IPC surface (PRD §8.5): a PTY registry on
 * top of the agent link. Create/attach/input/resize/close, Job Mode
 * (forwarded to BOTH the control plane's job-mode route — the lifecycle
 * truth that pins the machine awake — and the agent's job.set), output
 * streamed to the renderer as terminal:data, and the resumed/reconstructed
 * distinction surfaced from pty.attached. Scrollback replays on every attach.
 */

import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type { TerminalInfo } from "../../shared/ipc";
import type { ControlClient } from "../control-client";
import type { AgentLink, PtyChannel } from "./agent-client";

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

export interface TerminalDeps {
  link: AgentLink;
  control: () => ControlClient | null;
  emitData: (payload: { ptyId: string; data: string }) => void;
  emitUpdated: (terminals: TerminalInfo[]) => void;
  /**
   * Where a new shell starts when the caller names no directory — the active
   * space's folder in the shared filesystem, pre-created so the spawn cannot
   * land in a missing dir. null ⇒ let the agent pick its default (~/cloud on
   * the VM, the sim root locally). Async: it may mkdir over the link first.
   */
  defaultCwd?: () => Promise<string | null>;
}

interface TerminalRecord {
  info: TerminalInfo;
  channel: PtyChannel | null;
  decoder: StringDecoder;
}

/**
 * What an in-main observer of one PTY sees. `reset` fires when an attach is
 * about to replay the whole scrollback — observers holding a terminal model
 * must clear it or the replay would double-feed them (the same contract the
 * renderer's xterm follows).
 */
export type TerminalTapEvent =
  | { kind: "data"; text: string }
  | { kind: "reset" }
  | { kind: "resize"; cols: number; rows: number }
  | { kind: "exited"; code: number };

export class TerminalService {
  private readonly records = new Map<string, TerminalRecord>();
  private readonly taps = new Map<
    string,
    Set<(event: TerminalTapEvent) => void>
  >();
  private counter = 0;

  constructor(private readonly deps: TerminalDeps) {
    deps.link.onCtlEvent((event) => {
      if (event.t !== "pty.exited") return;
      const record = this.records.get(event.ptyId);
      if (record === undefined || record.info.exited) return;
      record.info.exited = true;
      this.tap(event.ptyId, { kind: "exited", code: event.code });
      this.pushUpdated();
    });
  }

  /**
   * Observe one PTY's stream from MAIN (the assistant's shells): decoded
   * output, attach resets, resizes, and the exit. The renderer keeps its own
   * path (emitData); taps are additive and never buffer.
   */
  subscribe(
    ptyId: string,
    listener: (event: TerminalTapEvent) => void,
  ): () => void {
    let set = this.taps.get(ptyId);
    if (set === undefined) {
      set = new Set();
      this.taps.set(ptyId, set);
    }
    set.add(listener);
    return () => {
      const listeners = this.taps.get(ptyId);
      if (listeners === undefined) return;
      listeners.delete(listener);
      if (listeners.size === 0) this.taps.delete(ptyId);
    };
  }

  private tap(ptyId: string, event: TerminalTapEvent): void {
    const listeners = this.taps.get(ptyId);
    if (listeners === undefined) return;
    for (const listener of [...listeners]) listener(event);
  }

  list(): TerminalInfo[] {
    return [...this.records.values()].map((record) => ({ ...record.info }));
  }

  /**
   * Ask the agent what sessions exist and adopt the ones this device has
   * never seen — the cross-device leg of §8.5 M-2. A ptyId lives only in the
   * spawning desktop's registry, so a second device must import the agent's
   * list before `attach` can accept it. Sessions the agent reports as not
   * live are shown exited: attach still works and reports "reconstructed",
   * which is exactly what they are.
   */
  async discover(): Promise<TerminalInfo[]> {
    let response;
    try {
      response = await this.deps.link.ctl({ t: "pty.list" });
    } catch {
      return this.list(); // agent unreachable — the local view is all there is
    }
    if (response?.t !== "pty.listing") return this.list();
    for (const session of response.sessions) {
      const existing = this.records.get(session.ptyId);
      if (existing !== undefined) {
        existing.info.cwd = session.cwd;
        // A tmux-backed session can outlive and then recreate its disposable
        // agent PTY client, so discovery must be able to clear an earlier
        // exited marker as well as set one.
        existing.info.exited = !session.live;
        continue;
      }
      this.counter += 1;
      this.records.set(session.ptyId, {
        info: {
          ptyId: session.ptyId,
          title: session.command ?? `Shell ${this.counter}`,
          cwd: session.cwd,
          restore: null,
          jobMode: false,
          exited: !session.live,
        },
        channel: null,
        decoder: new StringDecoder("utf8"),
      });
    }
    this.pushUpdated();
    return this.list();
  }

  async create(
    cwd?: string,
    title?: string,
    command?: string,
  ): Promise<TerminalInfo> {
    const ptyId = randomUUID();
    if (cwd === undefined) {
      // Terminal and explorer open onto the same tree: new shells start in
      // the active space's folder when one is bound. Best-effort — a failed
      // lookup falls back to the agent's own default rather than blocking.
      try {
        cwd = (await this.deps.defaultCwd?.()) ?? undefined;
      } catch {
        cwd = undefined;
      }
    }
    const response = await this.deps.link.ctl({
      t: "pty.spawn",
      ptyId,
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      // The renderer is a full xterm.js emulator; without an explicit TERM
      // the shell inherits whatever the agent process was started with.
      env: { TERM: "xterm-256color", COLORTERM: "truecolor" },
      ...(cwd === undefined ? {} : { cwd }),
      ...(command === undefined ? {} : { command }),
    });
    if (response?.t === "error")
      throw new Error(`terminal: ${response.message}`);
    this.counter += 1;
    const record: TerminalRecord = {
      info: {
        ptyId,
        title: title ?? `Shell ${this.counter}`,
        cwd: cwd ?? "~",
        restore: null,
        jobMode: false,
        exited: false,
      },
      channel: null,
      decoder: new StringDecoder("utf8"),
    };
    this.records.set(ptyId, record);
    this.openChannel(record);
    this.pushUpdated();
    return { ...record.info };
  }

  /**
   * Attach (or re-attach): the agent answers whether the live process
   * survived or only its context did, and replays scrollback through the pty
   * channel. Callers reset their display before invoking (§8.5).
   */
  async attach(
    ptyId: string,
    cols?: number,
    rows?: number,
  ): Promise<TerminalInfo> {
    const record = this.require(ptyId);
    // Let the agent recreate a disposable tmux client first when necessary.
    // Opening pty/<id> afterwards is still gap-free: the agent subscribes to
    // live output before replaying the retained ring onto the new channel.
    const response = await this.deps.link.ctl({
      t: "pty.attach",
      ptyId,
      sinceByte: 0,
      ...(cols === undefined || rows === undefined ? {} : { cols, rows }),
    });
    if (response?.t === "error")
      throw new Error(`terminal: ${response.message}`);
    if (response?.t === "pty.attached") {
      if (response.ptyId !== ptyId)
        throw new Error(
          `terminal: attach response for ${response.ptyId} while selecting ${ptyId}`,
        );
      record.info.restore = response.restore;
      record.info.cwd = response.cwd;
      record.info.exited = response.restore !== "resumed";
    }
    // The channel reopens below and the agent replays the whole scrollback —
    // main-side observers must clear their models first.
    this.tap(ptyId, { kind: "reset" });
    this.openChannel(record);
    this.pushUpdated();
    return { ...record.info };
  }

  input(ptyId: string, data: string): void {
    this.records.get(ptyId)?.channel?.write(data);
  }

  async resize(ptyId: string, cols: number, rows: number): Promise<void> {
    this.require(ptyId);
    await this.deps.link.ctl({ t: "pty.resize", ptyId, cols, rows });
    this.tap(ptyId, { kind: "resize", cols, rows });
  }

  async close(ptyId: string): Promise<void> {
    const record = this.require(ptyId);
    record.channel?.close();
    // Main-side observers (notably AssistantShellService) must learn about a
    // renderer-initiated close before the registry entry disappears. The
    // eventual agent pty.exited event cannot do that: it arrives after this
    // record has been removed and is intentionally ignored as stale.
    this.tap(ptyId, { kind: "exited", code: -1 });
    this.records.delete(ptyId);
    this.taps.delete(ptyId);
    try {
      await this.deps.link.ctl({ t: "pty.kill", ptyId, signal: "TERM" });
    } catch {
      // Agent unreachable — the registry entry is gone either way; the real
      // process is the agent's to reap when the link returns.
    }
    this.pushUpdated();
  }

  /** Job Mode (§8.5): control plane first — it is what actually pins the
   *  machine awake and bills — then the agent's process-local flag. */
  async setJobMode(ptyId: string, enabled: boolean): Promise<TerminalInfo> {
    const record = this.require(ptyId);
    const client = this.deps.control();
    if (client !== null) {
      // A missing Phase-2 route resolves null (tolerated); a real control
      // failure throws so the toggle never lies about billing state.
      await client.setJobMode(ptyId, enabled);
    }
    const response = await this.deps.link.ctl({ t: "job.set", ptyId, enabled });
    if (response?.t === "error")
      throw new Error(`terminal: ${response.message}`);
    record.info.jobMode =
      response?.t === "job.ack" ? response.enabled : enabled;
    this.pushUpdated();
    return { ...record.info };
  }

  /* ------------------------------ internals ------------------------------ */

  private openChannel(record: TerminalRecord): void {
    record.channel?.close();
    record.decoder = new StringDecoder("utf8");
    record.channel = this.deps.link.openPty(record.info.ptyId, (chunk) => {
      const text = record.decoder.write(chunk);
      if (text.length > 0) {
        this.deps.emitData({ ptyId: record.info.ptyId, data: text });
        this.tap(record.info.ptyId, { kind: "data", text });
      }
    });
  }

  private require(ptyId: string): TerminalRecord {
    const record = this.records.get(ptyId);
    if (record === undefined) throw new Error(`unknown terminal ${ptyId}`);
    return record;
  }

  private pushUpdated(): void {
    this.deps.emitUpdated(this.list());
  }
}
