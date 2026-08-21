/**
 * TerminalScreen — a headless terminal model for the assistant's shells.
 *
 * The assistant reads terminals as TEXT, but PTY output is a redraw stream:
 * cursor addressing, wrapped lines, colors, and (through tmux on the VM)
 * full-screen repaints. Feeding the bytes to @xterm/headless — the same
 * emulator family the renderer's terminal uses — resolves all of that into
 * an accurate grid + scrollback, so sentinel matching and TUI reading (e.g.
 * Claude Code) see what a human would see, not escape soup.
 *
 * This file is the single seam around the dependency: if @xterm/headless
 * ever misbehaves in the Electron main process, reimplement this class over
 * a ring buffer + stripAnsi and nothing else changes.
 */

import { Terminal } from "@xterm/headless";

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
/** Plenty for "recent output" reads; full history lives in the agent. */
const SCROLLBACK_LINES = 5_000;

export class TerminalScreen {
  private readonly term: Terminal;
  /** xterm parses writes asynchronously; readers await the queue. */
  private pending: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(cols = DEFAULT_COLS, rows = DEFAULT_ROWS) {
    this.term = new Terminal({
      cols,
      rows,
      scrollback: SCROLLBACK_LINES,
      allowProposedApi: true,
    });
  }

  write(data: string): void {
    if (this.disposed) return;
    this.pending = new Promise((resolve) => {
      try {
        this.term.write(data, resolve);
      } catch {
        resolve();
      }
    });
  }

  /** Resolves when everything written so far has been parsed. */
  flush(): Promise<void> {
    return this.pending;
  }

  /** Attach replay is about to resend the whole scrollback — start clean. */
  reset(): void {
    if (this.disposed) return;
    this.term.reset();
  }

  resize(cols: number, rows: number): void {
    if (this.disposed) return;
    this.term.resize(cols, rows);
  }

  /** The visible grid, trailing blank rows trimmed — what a user looking at
   *  the terminal sees right now (the right read for TUIs). */
  screenText(): string {
    const buffer = this.term.buffer.active;
    const rows: string[] = [];
    const start = Math.max(0, buffer.length - this.term.rows);
    for (let y = start; y < buffer.length; y++) {
      rows.push(buffer.getLine(y)?.translateToString(true) ?? "");
    }
    while (rows.length > 0 && (rows[rows.length - 1] as string).trim() === "") {
      rows.pop();
    }
    return rows.join("\n");
  }

  /** The last `lines` LOGICAL lines of scrollback+screen — rows soft-wrapped
   *  by terminal width are joined back into one line, so a sentinel or long
   *  log line can be matched whole. */
  tailText(lines: number): string {
    const buffer = this.term.buffer.active;
    const logical: string[] = [];
    for (let y = 0; y < buffer.length; y++) {
      const line = buffer.getLine(y);
      if (line === undefined) continue;
      const text = line.translateToString(true);
      if (line.isWrapped && logical.length > 0) {
        logical[logical.length - 1] += text;
      } else {
        logical.push(text);
      }
    }
    while (
      logical.length > 0 &&
      (logical[logical.length - 1] as string).trim() === ""
    ) {
      logical.pop();
    }
    return logical.slice(Math.max(0, logical.length - lines)).join("\n");
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.term.dispose();
  }
}
