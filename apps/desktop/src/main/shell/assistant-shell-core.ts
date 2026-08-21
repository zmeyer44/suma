/**
 * assistant-shell-core — the assistant's command execution, PURE half.
 *
 * The agent protocol has no exec verb — only interactive PTYs — so "run a
 * command and know when it finished" is built from what exists: the command
 * is written to a script file over the vfs, a short `bash '<path>'` line is
 * typed into an assistant-owned shell, and a wrapper script prints a
 * nonce-stamped sentinel with the exit code when the command ends.
 *
 * Why scripts instead of typing the command: typed text is echoed (raw PTY
 * echo, ZLE redraw, tmux repaint, the sim's cooked fallback), so any sentinel
 * that appears on the typed line would match its own echo; multiline commands
 * would strand interactive shells at continuation prompts; tabs would trigger
 * completion; and canonical mode caps a typed line at 4096 bytes. A script
 * file has none of those problems, and `bash '<path>'` is valid argv in
 * zsh, bash, and fish alike. The sentinel itself exists only as SEPARATE
 * printf arguments inside the wrapper ("<<%s:%d>>" and "SUMA-<nonce>"), so
 * no echo, scrollback replay, or `cat` of the scripts can ever produce a
 * match — only actually running the wrapper can.
 *
 * POSIX only: macOS locally, the Ubuntu VM in the cloud. Everything here is
 * pure (no I/O); the PTY plumbing lives in assistant-shell-service.ts.
 */

/** Where job scripts live in the VFS — under the hidden app-data folder
 *  (".suma" is tree-skipped, so they never appear in the IDE explorer). */
export const JOBS_DIR = "/.suma/jobs";

/** One tool result's output budget. Terminal output is repetitive; past this
 *  the middle is elided, keeping the head (the command's opening words) and
 *  a larger tail (errors and summaries live at the end). */
export const OUTPUT_BUDGET_BYTES = 16 * 1024;

/** ^U — kill-line, clears anything half-typed in the shell before our line. */
const KILL_LINE = "\x15";

export interface JobPlan {
  jobId: string;
  nonce: string;
  /** VFS paths (rooted, "/.suma/jobs/…") for writing the scripts. */
  cmdVfsPath: string;
  ctlVfsPath: string;
  /** File contents. */
  cmdScript: string;
  ctlScript: string;
  /** The single short line typed into the PTY (ends with \r). */
  typedLine: string;
}

/** POSIX single-quote escaping: 'it'\''s' — safe for any byte but NUL. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, "'\\''")}'`;
}

/**
 * A shell expression for a path that may be ~-rooted. Quoting a leading `~`
 * would kill its expansion, so `~/cloud/x` becomes `"$HOME"'/cloud/x'` —
 * concatenation of an expandable piece and a fully quoted one, valid in
 * zsh/bash/fish and inside the bash wrapper alike.
 */
export function shellPathExpr(path: string): string {
  if (path === "~") return '"$HOME"';
  if (path.startsWith("~/")) return `"$HOME"${shellQuote(path.slice(1))}`;
  return shellQuote(path);
}

/** join that tolerates a ~-rooted or absolute base and a relative tail. */
export function joinShellPath(base: string, rel: string): string {
  const trimmed = rel.replace(/^\/+/u, "");
  if (trimmed === "") return base;
  return `${base.replace(/\/+$/u, "")}/${trimmed}`;
}

/**
 * Plan one command invocation. `absCwd` and `shellRoot` are shell-side paths
 * (absolute or ~-rooted); the caller provides the nonce (8 hex chars) and a
 * jobId whose characters are filename-safe.
 */
export function planJob(
  command: string,
  absCwd: string,
  shellRoot: string,
  jobId: string,
  nonce: string,
): JobPlan {
  if (!/^[A-Za-z0-9-]+$/u.test(jobId) || !/^[0-9a-f]{8}$/u.test(nonce)) {
    throw new Error(`invalid job identity: ${jobId} / ${nonce}`);
  }
  const cmdVfsPath = `${JOBS_DIR}/${jobId}.cmd.sh`;
  const ctlVfsPath = `${JOBS_DIR}/${jobId}.ctl.sh`;
  const cmdShellPath = shellPathExpr(joinShellPath(shellRoot, cmdVfsPath));
  const marker = shellQuote(`SUMA-${nonce}`);
  // The sentinel format string and the marker stay separate printf ARGUMENTS
  // so the assembled "<<SUMA-…:…>>" text exists nowhere on disk or on the
  // typed line. cd failure gets its own exit (97) so a bad cwd is loud. The
  // command runs in a CHILD bash: an `exit` inside it cannot skip the
  // sentinel, and the wrapper still reports its code.
  const ctlScript = [
    "export NO_COLOR=1",
    `cd ${shellPathExpr(absCwd)} || { printf '\\n<<%s:%d>>\\n' ${marker} 97; exit 97; }`,
    `bash ${cmdShellPath}`,
    "__suma_rc=$?",
    `printf '\\n<<%s:%d>>\\n' ${marker} "$__suma_rc"`,
    'exit "$__suma_rc"',
  ].join("\n");
  return {
    jobId,
    nonce,
    cmdVfsPath,
    ctlVfsPath,
    cmdScript: command.endsWith("\n") ? command : `${command}\n`,
    ctlScript: `${ctlScript}\n`,
    typedLine: `${KILL_LINE}bash ${shellPathExpr(joinShellPath(shellRoot, ctlVfsPath))}\r`,
  };
}

/** The completion sentinel, if the wrapper has printed it. Matched against
 *  terminal-model text (column 0, under 30 chars — never wrapped). The LAST
 *  match wins so a replayed scrollback containing an old run of the same
 *  nonce (impossible across jobs, harmless within one) stays correct. */
export function sentinelIn(
  text: string,
  nonce: string,
): { exitCode: number } | null {
  const pattern = new RegExp(`<<SUMA-${nonce}:(-?\\d+)>>`, "gu");
  let last: RegExpExecArray | null = null;
  for (let m = pattern.exec(text); m !== null; m = pattern.exec(text)) {
    last = m;
  }
  if (last === null) return null;
  return { exitCode: Number.parseInt(last[1] as string, 10) };
}

/**
 * The command's own output: the terminal text between the echo of the typed
 * `bash …<jobId>.ctl.sh` line (jobId is unique, so the echo is findable) and
 * the sentinel line. Falls back to everything before the sentinel when the
 * echo is not found (cooked-mode echo can mangle it).
 */
export function extractJobOutput(
  text: string,
  jobId: string,
  nonce: string,
): string {
  let out = text;
  const sentinel = new RegExp(`^.*<<SUMA-${nonce}:-?\\d+>>.*$`, "mu").exec(out);
  if (sentinel !== null) out = out.slice(0, sentinel.index);
  const echoAt = out.lastIndexOf(`${jobId}.ctl.sh`);
  if (echoAt !== -1) {
    const lineEnd = out.indexOf("\n", echoAt);
    out = lineEnd === -1 ? "" : out.slice(lineEnd + 1);
  }
  return out.replace(/^\n+/u, "").replace(/\s+$/u, "");
}

const encoder = new TextEncoder();

function utf8Bytes(text: string): number {
  return encoder.encode(text).byteLength;
}

/** Take at most maxBytes of UTF-8 from the start (or end) of text without
 *  splitting a code point — done by characters, checked by bytes. */
function takeBytes(text: string, maxBytes: number, fromEnd: boolean): string {
  if (utf8Bytes(text) <= maxBytes) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const slice = fromEnd ? text.slice(text.length - mid) : text.slice(0, mid);
    if (utf8Bytes(slice) <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  return fromEnd ? text.slice(text.length - lo) : text.slice(0, lo);
}

/** Budgeted output: head 25% + elision marker + tail 75% — errors and
 *  summaries live at the end of terminal output, so the tail gets the room. */
export function cleanOutput(
  text: string,
  maxBytes: number = OUTPUT_BUDGET_BYTES,
): { text: string; truncated: boolean } {
  const total = utf8Bytes(text);
  if (total <= maxBytes) return { text, truncated: false };
  const head = takeBytes(text, Math.floor(maxBytes * 0.25), false);
  const tail = takeBytes(text, Math.floor(maxBytes * 0.75), true);
  const omitted = total - utf8Bytes(head) - utf8Bytes(tail);
  return {
    text: `${head}\n…[${omitted} bytes of output omitted]…\n${tail}`,
    truncated: true,
  };
}

/** Fallback cleaner for raw PTY bytes (the terminal model is the primary
 *  path): CSI/OSC/escape sequences out, carriage returns resolved. */
export function stripAnsi(text: string): string {
  /* eslint-disable no-control-regex -- terminal escapes ARE control bytes */
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/gu, "") // OSC … BEL/ST
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/gu, "") // CSI
    .replace(/\x1b[@-_]/gu, "") // bare ESC pairs
    .replace(/[^\S\n]*\r(?!\n)/gu, "\n")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/gu, "");
  /* eslint-enable no-control-regex */
}

/** Named keys the send_keys tool accepts, mapped to their byte sequences. */
const KEY_SEQUENCES: Readonly<Record<string, string>> = {
  Enter: "\r",
  Escape: "\x1b",
  Tab: "\t",
  Backspace: "\x7f",
  Space: " ",
  Up: "\x1b[A",
  Down: "\x1b[B",
  Right: "\x1b[C",
  Left: "\x1b[D",
  PageUp: "\x1b[5~",
  PageDown: "\x1b[6~",
  Home: "\x1b[H",
  End: "\x1b[F",
  "C-c": "\x03",
  "C-d": "\x04",
  "C-l": "\x0c",
  "C-u": "\x15",
  "C-z": "\x1a",
};

export const SEND_KEY_NAMES: ReadonlyArray<string> = Object.keys(KEY_SEQUENCES);

/** Resolve a list of named keys to the bytes to write, or throw naming the
 *  first unknown key (the model can correct itself). */
export function resolveSendKeys(keys: string[]): string {
  let out = "";
  for (const key of keys) {
    const seq = KEY_SEQUENCES[key];
    if (seq === undefined) {
      throw new Error(
        `unknown key "${key}" — the named keys are: ${SEND_KEY_NAMES.join(", ")}`,
      );
    }
    out += seq;
  }
  return out;
}
