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
}

interface TerminalRecord {
  info: TerminalInfo;
  channel: PtyChannel | null;
  decoder: StringDecoder;
}

export class TerminalService {
  private readonly records = new Map<string, TerminalRecord>();
  private counter = 0;

  constructor(private readonly deps: TerminalDeps) {
    deps.link.onCtlEvent((event) => {
      if (event.t !== "pty.exited") return;
      const record = this.records.get(event.ptyId);
      if (record === undefined || record.info.exited) return;
      record.info.exited = true;
      this.pushUpdated();
    });
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
        if (!session.live) existing.info.exited = true;
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

  async create(cwd?: string): Promise<TerminalInfo> {
    const ptyId = randomUUID();
    const response = await this.deps.link.ctl({
      t: "pty.spawn",
      ptyId,
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      // The renderer is a full xterm.js emulator; without an explicit TERM
      // the shell inherits whatever the agent process was started with.
      env: { TERM: "xterm-256color", COLORTERM: "truecolor" },
      ...(cwd === undefined ? {} : { cwd }),
    });
    if (response?.t === "error") throw new Error(`terminal: ${response.message}`);
    this.counter += 1;
    const record: TerminalRecord = {
      info: {
        ptyId,
        title: `Shell ${this.counter}`,
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
  async attach(ptyId: string): Promise<TerminalInfo> {
    const record = this.require(ptyId);
    // Re-open the byte channel first so the replay has somewhere to land.
    this.openChannel(record);
    const response = await this.deps.link.ctl({ t: "pty.attach", ptyId, sinceByte: 0 });
    if (response?.t === "error") throw new Error(`terminal: ${response.message}`);
    if (response?.t === "pty.attached") {
      record.info.restore = response.restore;
      record.info.cwd = response.cwd;
    }
    this.pushUpdated();
    return { ...record.info };
  }

  input(ptyId: string, data: string): void {
    this.records.get(ptyId)?.channel?.write(data);
  }

  async resize(ptyId: string, cols: number, rows: number): Promise<void> {
    this.require(ptyId);
    await this.deps.link.ctl({ t: "pty.resize", ptyId, cols, rows });
  }

  async close(ptyId: string): Promise<void> {
    const record = this.require(ptyId);
    record.channel?.close();
    this.records.delete(ptyId);
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
    if (response?.t === "error") throw new Error(`terminal: ${response.message}`);
    record.info.jobMode = response?.t === "job.ack" ? response.enabled : enabled;
    this.pushUpdated();
    return { ...record.info };
  }

  /* ------------------------------ internals ------------------------------ */

  private openChannel(record: TerminalRecord): void {
    record.channel?.close();
    record.decoder = new StringDecoder("utf8");
    record.channel = this.deps.link.openPty(record.info.ptyId, (chunk) => {
      const text = record.decoder.write(chunk);
      if (text.length > 0) this.deps.emitData({ ptyId: record.info.ptyId, data: text });
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
