/**
 * UpdateService — background self-updates from the zmeyer44/suma GitHub
 * releases feed (electron-builder's `publish` config, baked into the app as
 * app-update.yml; runbook in docs/release-macos.md).
 *
 * The whole cycle is deliberately hands-off: check shortly after launch and
 * every few hours after, download in the background, install on quit
 * (Squirrel.Mac swaps the bundle after the app exits). The user-facing
 * surface is one settings page and one menu item — the only decision a
 * person ever has to make is "restart now or keep working", and doing
 * nothing still updates them at next quit.
 *
 * APP-LEVEL, not account-level: constructed once in bootstrap, never torn
 * down on sign-out. electron-updater's autoUpdater is a process singleton —
 * rebuilding this per account graph would stack duplicate listeners on it.
 * Account graphs subscribe via `onChanged` and unsubscribe in their teardown.
 *
 * Dev builds (`!app.isPackaged`) mark the state `unsupported` and never touch
 * the network. A PACKAGED but unsigned build (dist:mac) fails Squirrel's
 * signature validation instead — that surfaces as an `error` state on the
 * About page, which is honest: that artifact genuinely cannot update itself.
 */

import { app } from "electron";
// electron-updater is CJS with getter-based exports; named ESM imports
// don't resolve at runtime, so import the module object and destructure.
import electronUpdater from "electron-updater";
import { initialUpdateState, type UpdateState } from "../../shared/updates";
import { reduceUpdate, type UpdateEvent } from "./update-core";

const { autoUpdater } = electronUpdater;

/** First check waits out the boot rush; later checks are periodic. */
const FIRST_CHECK_DELAY_MS = 20_000;
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

export class UpdateService {
  private current: UpdateState;
  private readonly listeners = new Set<(state: UpdateState) => void>();
  private readonly supported: boolean;
  private firstCheck: NodeJS.Timeout | null = null;
  private interval: NodeJS.Timeout | null = null;
  private started = false;

  constructor() {
    this.supported = app.isPackaged;
    this.current = initialUpdateState(app.getVersion(), this.supported);
  }

  state(): UpdateState {
    return this.current;
  }

  /** Subscribe to transitions; returns unsubscribe (account teardown calls it). */
  onChanged(listener: (state: UpdateState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Attach to autoUpdater and begin the check cadence. Idempotent. */
  start(): void {
    if (!this.supported || this.started) return;
    this.started = true;

    autoUpdater.autoDownload = true;
    // Doing nothing still updates you: quit stages the swap.
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.logger = null;

    autoUpdater.on("checking-for-update", () =>
      this.apply({ kind: "checking" }),
    );
    autoUpdater.on("update-not-available", () =>
      this.apply({ kind: "not-available", at: Date.now() }),
    );
    autoUpdater.on("update-available", (info) =>
      this.apply({ kind: "available", version: info.version }),
    );
    autoUpdater.on("download-progress", (progress) =>
      this.apply({ kind: "progress", percent: progress.percent }),
    );
    autoUpdater.on("update-downloaded", (info) =>
      this.apply({ kind: "downloaded", version: info.version, at: Date.now() }),
    );
    autoUpdater.on("error", (err) =>
      this.apply({ kind: "error", message: presentableError(err) }),
    );

    this.firstCheck = setTimeout(() => this.check(), FIRST_CHECK_DELAY_MS);
    this.interval = setInterval(() => this.check(), CHECK_INTERVAL_MS);
  }

  /**
   * Kick off a check now (menu item, About page button). Fire-and-forget:
   * every outcome — including the rejection checkForUpdates duplicates onto
   * the "error" event — arrives through the listeners above.
   */
  check(): void {
    if (!this.supported || !this.started) return;
    // A check is already running or its download is; let it finish.
    if (this.current.phase === "checking" || this.current.phase === "downloading")
      return;
    autoUpdater.checkForUpdates().catch(() => undefined);
  }

  /** Quit into the downloaded version. No-op unless one is staged. */
  install(): void {
    if (this.current.phase !== "ready") return;
    autoUpdater.quitAndInstall();
  }

  /** Quit-time cleanup only — this service outlives sign-out. */
  stop(): void {
    if (this.firstCheck !== null) clearTimeout(this.firstCheck);
    if (this.interval !== null) clearInterval(this.interval);
    this.firstCheck = null;
    this.interval = null;
  }

  private apply(event: UpdateEvent): void {
    const next = reduceUpdate(this.current, event);
    if (next === this.current) return;
    this.current = next;
    for (const listener of this.listeners) listener(next);
  }
}

/**
 * electron-updater errors are stack-first and jargon-heavy; the About page
 * shows this string verbatim, so translate the common cases and truncate
 * the rest to their first line.
 */
function presentableError(err: Error): string {
  const raw = err.message || "Unknown error";
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ERR_INTERNET|net::/i.test(raw)) {
    return "Couldn't reach the update server. Suma will retry automatically.";
  }
  if (/code signature|not signed|codesign/i.test(raw)) {
    return "This build isn't signed for automatic updates.";
  }
  if (/404|No published versions|Cannot find latest/i.test(raw)) {
    return "No published releases to update from yet.";
  }
  const firstLine = raw.split("\n", 1)[0] ?? raw;
  return firstLine.length > 200 ? `${firstLine.slice(0, 200)}…` : firstLine;
}
