/**
 * DownloadRouter — the `will-download` intercept that decides, per download,
 * between this Mac and the cloud fetcher (PRD §8.6).
 *
 * It attaches to every space session alongside the Phase-1 DownloadManager:
 *
 *   1. `webRequest.onBeforeSendHeaders` records the credential shape of every
 *      outgoing request (does it carry a Cookie? an Authorization header?)
 *      AGAINST THE SPACE THAT MADE IT. This is the only way the browser learns
 *      what a download would send, and a space is a cookie jar — an
 *      observation from one says nothing about the same URL in another.
 *   2. `will-download` builds a DownloadContext from that observation and asks
 *      the FROZEN `cloudFetchEligibility`. Eligible ⇒ a transfer is created and
 *      the local download is cancelled ONCE THE CLOUD HAS ACCEPTED IT; anything
 *      else ⇒ the download proceeds locally and DownloadManager tracks it as it
 *      always has. The local write is never given up on a promise.
 *   3. When the refusal is `credentialed_request` (or a credential in the URL),
 *      the §8.6 explanation is surfaced — a user who is told "authenticated
 *      downloads stay on your Mac" learns the rule; a user left guessing
 *      concludes Suma is arbitrary.
 *
 * The credential never moves: what is handed to the control plane is the URL
 * that the eligibility check already proved carries no cookie, no
 * Authorization header, no client certificate, and no userinfo. There is no
 * code path here that reads a cookie jar or forwards a request header.
 *
 * Electron is imported for TYPES ONLY, so this module stays unit-testable.
 */

import type { DownloadItem, Session } from "electron";
import type { CloudFetchDeclined } from "../../shared/ipc";
import { RequestSignalTracker, routeDownload, type DownloadRoute } from "./download-context";

/**
 * Resource types that can NEVER become a download, and so are the only ones
 * worth skipping. A deny-list rather than an allow-list because the cost of
 * the two mistakes is not symmetric: any request type the recorder misses is a
 * download whose credential shape is unknown, and unknown means the §8.6 rule
 * fails closed to a local download even for a plainly public file. An `<img>`
 * or `<video>` answered with `Content-Disposition: attachment` is exactly that
 * case, and an allow-list of five types missed it — as would any type Electron
 * adds later, which a deny-list records by default.
 */
const UNTRACKED_RESOURCE_TYPES: ReadonlySet<string> = new Set(["webSocket", "ping", "cspReport"]);

export interface DownloadRouterDeps {
  /** Whether a cloud fetch can be created at all right now. */
  cloudAvailable: () => boolean;
  /** User setting: keep downloads on this Mac (§8.6 `alwaysLocal`). */
  alwaysLocal: () => boolean;
  /**
   * Create the transfer for an eligible download. Resolves true only when the
   * cloud has accepted it — false means the local download must carry on.
   */
  startCloudFetch: (args: {
    url: string;
    filename: string;
    destPath: string;
    totalBytes: number;
    spaceId: string;
  }) => Promise<boolean>;
  /** Tell the user why this one stayed local (§8.6). */
  onDeclined: (declined: CloudFetchDeclined) => void;
  /** Shared session header hook; Electron keeps only one listener per event. */
  requestHeaders?: {
    addObserver: (
      observer: (
        spaceId: string,
        details: Electron.OnBeforeSendHeadersListenerDetails,
        headers: Record<string, string>,
      ) => void,
    ) => void;
  };
  now?: () => number;
}

export class DownloadRouter {
  private readonly signals = new RequestSignalTracker();

  constructor(private readonly deps: DownloadRouterDeps) {
    deps.requestHeaders?.addObserver((spaceId, details, headers) => {
      this.observeRequestHeaders(spaceId, details, headers);
    });
  }

  /** SpaceManager session hook — one request recorder + one intercept. */
  attachTo(ses: Session, spaceId: string): void {
    // Legacy/test fallback. Production shares the bridge's one listener so
    // installing this observer cannot replace the native metadata repair.
    if (this.deps.requestHeaders === undefined) {
      ses.webRequest.onBeforeSendHeaders((details, callback) => {
        this.observeRequestHeaders(spaceId, details, details.requestHeaders);
        callback({ requestHeaders: details.requestHeaders });
      });
    }
    // No `preventDefault()`: the local download always starts, and is
    // cancelled later only if the cloud takes it (see onWillDownload).
    ses.on("will-download", (_event, item) => {
      this.onWillDownload(item, spaceId);
    });
  }

  private observeRequestHeaders(
    spaceId: string,
    details: Pick<Electron.OnBeforeSendHeadersListenerDetails, "resourceType" | "url">,
    requestHeaders: Record<string, string>,
  ): void {
    if (UNTRACKED_RESOURCE_TYPES.has(details.resourceType)) return;
    // Recorded against THIS space: another space's cookie jar must never
    // answer for this one (§8.6).
    this.signals.note(spaceId, details.url, requestHeaders, this.now());
  }

  /**
   * Chromium asked for a client certificate — that origin authenticates with
   * TLS client auth, which can never leave this Mac. Observed passively:
   * `event.preventDefault()` is deliberately NOT called, so Electron's default
   * certificate selection is unchanged.
   */
  noteClientCertificate(url: string): void {
    this.signals.noteClientCert(url, this.now());
  }

  /**
   * Exposed for the intercept and for tests that drive it directly. The space
   * is part of the question, not context: a download is judged only on what
   * ITS OWN session was seen to send.
   */
  decide(item: {
    url: string;
    filename: string;
    totalBytes: number;
    spaceId: string;
  }): DownloadRoute {
    const now = this.now();
    return routeDownload({
      url: item.url,
      filename: item.filename,
      totalBytes: item.totalBytes,
      signals: this.signals.signalsFor(item.spaceId, item.url, now),
      alwaysLocal: this.deps.alwaysLocal(),
      cloudAvailable: this.deps.cloudAvailable(),
    });
  }

  /* ------------------------------ internals ------------------------------ */

  private onWillDownload(item: DownloadItem, spaceId: string): void {
    let url: string;
    let filename: string;
    let totalBytes: number;
    try {
      url = item.getURL();
      filename = item.getFilename();
      totalBytes = item.getTotalBytes();
    } catch {
      return; // the item is already gone — the local path is unaffected
    }

    const route = this.decide({ url, filename, totalBytes, spaceId });
    if (route.kind === "local") {
      if (route.notify) {
        this.deps.onDeclined({
          url,
          filename,
          reason: route.refusal,
          explanation: route.explanation,
          atMs: this.now(),
        });
      }
      return; // DownloadManager owns it from here, exactly as in Phase 1
    }

    // Eligible: ask the cloud to take it — but do NOT stop the local download
    // yet. `event.preventDefault()` here cancelled the local write before the
    // cloud had accepted anything, so any refusal on the other side (the
    // account not enabled for cloud fetch, the control plane down, a quota
    // rejection) destroyed the download outright: nothing on this Mac, nothing
    // in Files. The local write is the fallback, so it keeps running until the
    // cloud has actually taken ownership; only then is it cancelled.
    //
    // The cost is a few seconds of duplicated bytes on the happy path. The
    // Phase-1 DownloadManager still owns the row either way, and the downloads
    // panel relabels rows whose URL has become a transfer, so a routed
    // download reads as "moved to a cloud fetch" rather than as something the
    // user cancelled.
    void this.deps
      .startCloudFetch({ url, filename, destPath: route.destPath, totalBytes, spaceId })
      .then((accepted) => {
        if (accepted) this.cancelLocal(item);
      })
      .catch(() => {
        // startCloudFetch reports its own failure as a failed transfer; the
        // local download simply carries on.
      });
  }

  /** The cloud owns this download now — stop the local copy, if it is still running. */
  private cancelLocal(item: DownloadItem): void {
    try {
      if (item.getState() === "progressing") item.cancel();
    } catch {
      // The item finished or was destroyed while the cloud was deciding —
      // the user has the file either way.
    }
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }
}
