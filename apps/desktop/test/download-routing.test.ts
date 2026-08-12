/**
 * §8.6 download routing — the rule that must not be weakened.
 *
 * v1.0's "sealed one-shot request" shipped the user's URL and Cookie header
 * into the VM. §8.6 deleted it. These tests exist to make sure no future edit
 * quietly re-opens that path: every case where a credential is (or might be)
 * involved must resolve to "stays on this Mac", and the authenticated case
 * must be explained to the user rather than silently handled.
 */

import { describe, expect, it } from "vitest";
import { CLOUD_FETCH_MIN_BYTES } from "@suma/protocol";
import type { DownloadItem, Session } from "electron";
import {
  buildDownloadContext,
  cloudDestPath,
  RequestSignalTracker,
  routeDownload,
  safeFilename,
  SIGNAL_TTL_MS,
  type CredentialSignals,
  type DownloadRouteInput,
} from "../src/main/files/download-context";
import { DownloadRouter } from "../src/main/files/download-router";
import type { CloudFetchDeclined } from "../src/shared/ipc";

const BIG = CLOUD_FETCH_MIN_BYTES * 2;

const CLEAN: CredentialSignals = { hasCookies: false, hasAuthHeader: false, usesClientCert: false };

function input(overrides: Partial<DownloadRouteInput> = {}): DownloadRouteInput {
  return {
    url: "https://cdn.example.com/big.zip",
    filename: "big.zip",
    totalBytes: BIG,
    signals: CLEAN,
    alwaysLocal: false,
    cloudAvailable: true,
    ...overrides,
  };
}

const SPACE = "space-1";
const OTHER_SPACE = "space-2";

describe("RequestSignalTracker (what the browser can observe)", () => {
  it("reads Cookie and Authorization off the real request headers", async () => {
    const tracker = new RequestSignalTracker();
    tracker.note(SPACE, "https://a.example/x", { Cookie: "sid=1", Accept: "*/*" }, 1_000);
    tracker.note(SPACE, "https://b.example/x", { authorization: "Bearer t" }, 1_000);
    tracker.note(SPACE, "https://c.example/x", { accept: "*/*" }, 1_000);

    expect(tracker.signalsFor(SPACE, "https://a.example/x", 1_000)?.hasCookies).toBe(true);
    expect(tracker.signalsFor(SPACE, "https://b.example/x", 1_000)?.hasAuthHeader).toBe(true);
    expect(tracker.signalsFor(SPACE, "https://c.example/x", 1_000)).toEqual(CLEAN);
  });

  it("treats an empty Cookie header as no cookies", async () => {
    const tracker = new RequestSignalTracker();
    tracker.note(SPACE, "https://a.example/x", { cookie: "" }, 0);
    expect(tracker.signalsFor(SPACE, "https://a.example/x", 0)?.hasCookies).toBe(false);
  });

  it("matches the download URL to its request across a fragment", async () => {
    const tracker = new RequestSignalTracker();
    tracker.note(SPACE, "https://a.example/x?y=1", { cookie: "sid=1" }, 0);
    expect(tracker.signalsFor(SPACE, "https://a.example/x?y=1#frag", 0)?.hasCookies).toBe(true);
  });

  it("forgets unobserved and stale requests rather than vouching for them", async () => {
    const tracker = new RequestSignalTracker();
    tracker.note(SPACE, "https://a.example/x", { accept: "*/*" }, 0);
    expect(tracker.signalsFor(SPACE, "https://never.example/x", 0)).toBeNull();
    expect(tracker.signalsFor(SPACE, "https://a.example/x", SIGNAL_TTL_MS + 1)).toBeNull();
  });

  it("marks an origin that asked for a client certificate", async () => {
    const tracker = new RequestSignalTracker();
    tracker.note(SPACE, "https://corp.example/report.pdf", { accept: "*/*" }, 0);
    tracker.noteClientCert("https://corp.example/auth", 10);
    expect(tracker.signalsFor(SPACE, "https://corp.example/report.pdf", 20)?.usesClientCert).toBe(
      true,
    );
  });

  it("NEVER LETS ONE SPACE'S COOKIE JAR VOUCH FOR ANOTHER'S", async () => {
    // The same URL, loaded signed-out in one space and signed-in in another.
    // Each space has its own cookie jar, so neither observation may answer for
    // the other — and the space that never made the request has nothing.
    const tracker = new RequestSignalTracker();
    const url = "https://drive.example/report.zip";
    tracker.note(SPACE, url, { accept: "*/*" }, 0);
    tracker.note(OTHER_SPACE, url, { cookie: "sid=1" }, 0);

    expect(tracker.signalsFor(SPACE, url, 0)).toEqual(CLEAN);
    expect(tracker.signalsFor(OTHER_SPACE, url, 0)?.hasCookies).toBe(true);
    expect(tracker.signalsFor("space-3", url, 0)).toBeNull();
  });

  it("cannot be talked out of a credential by a later cookie-less request", async () => {
    // `fetch(url, {credentials: "omit"})` for a URL this space also loads with
    // cookies: within one session nothing links a download back to which
    // request produced it, so the credential wins in both orders.
    const tracker = new RequestSignalTracker();
    const url = "https://drive.example/report.zip";
    tracker.note(SPACE, url, { cookie: "sid=1" }, 0);
    tracker.note(SPACE, url, { accept: "*/*" }, 10);
    expect(tracker.signalsFor(SPACE, url, 10)?.hasCookies).toBe(true);

    const reversed = new RequestSignalTracker();
    reversed.note(SPACE, url, { accept: "*/*" }, 0);
    reversed.note(SPACE, url, { authorization: "Bearer t" }, 10);
    expect(reversed.signalsFor(SPACE, url, 10)?.hasAuthHeader).toBe(true);
  });

  it("stops carrying a credential forward once the observation has expired", async () => {
    // Pessimistic merging must not make a flag permanent: past the TTL the old
    // observation is gone, and a fresh clean request stands on its own.
    const tracker = new RequestSignalTracker();
    const url = "https://drive.example/report.zip";
    tracker.note(SPACE, url, { cookie: "sid=1" }, 0);
    tracker.note(SPACE, url, { accept: "*/*" }, SIGNAL_TTL_MS + 1);
    expect(tracker.signalsFor(SPACE, url, SIGNAL_TTL_MS + 1)).toEqual(CLEAN);
  });
});

describe("buildDownloadContext", () => {
  it("reports an undeclared length as null, not zero", async () => {
    expect(buildDownloadContext(input({ totalBytes: 0 })).totalBytes).toBeNull();
    expect(buildDownloadContext(input({ totalBytes: 42 })).totalBytes).toBe(42);
  });

  it("assumes a credential when the request was never observed", async () => {
    const ctx = buildDownloadContext(input({ signals: null }));
    expect(ctx.hasCookies).toBe(true);
    expect(ctx.hasAuthHeader).toBe(true);
  });

  it("passes the observed facts through unchanged", async () => {
    const ctx = buildDownloadContext(
      input({ signals: { hasCookies: true, hasAuthHeader: false, usesClientCert: true } }),
    );
    expect(ctx).toMatchObject({ hasCookies: true, hasAuthHeader: false, usesClientCert: true });
  });
});

describe("routeDownload (§8.6 eligibility)", () => {
  it("routes a large, credential-free public download to the cloud", async () => {
    const route = routeDownload(input());
    expect(route).toEqual({ kind: "cloud", reason: "public", destPath: "/Downloads/big.zip" });
  });

  it("recognizes a presigned URL as already-authorized by the origin", async () => {
    const route = routeDownload(
      input({ url: "https://s3.example.com/o.bin?X-Amz-Signature=abc&X-Amz-Credential=k" }),
    );
    expect(route).toMatchObject({ kind: "cloud", reason: "presigned" });
  });

  it("KEEPS A COOKIED DOWNLOAD LOCAL and explains why", async () => {
    const route = routeDownload(input({ signals: { ...CLEAN, hasCookies: true } }));
    expect(route.kind).toBe("local");
    if (route.kind !== "local") return;
    expect(route.refusal).toBe("credentialed_request");
    expect(route.notify).toBe(true);
    expect(route.explanation).toContain("never sends your credentials");
  });

  it("keeps an Authorization-header download local", async () => {
    const route = routeDownload(input({ signals: { ...CLEAN, hasAuthHeader: true } }));
    expect(route).toMatchObject({ kind: "local", refusal: "credentialed_request", notify: true });
  });

  it("keeps a client-certificate download local", async () => {
    const route = routeDownload(input({ signals: { ...CLEAN, usesClientCert: true } }));
    expect(route).toMatchObject({ kind: "local", refusal: "credentialed_request" });
  });

  it("keeps a URL with embedded userinfo local, and says so", async () => {
    const route = routeDownload(input({ url: "https://user:pw@cdn.example.com/big.zip" }));
    expect(route).toMatchObject({ kind: "local", refusal: "userinfo_in_url", notify: true });
  });

  it("never routes an unobserved request, and does not claim it was authenticated", async () => {
    const route = routeDownload(input({ signals: null }));
    expect(route.kind).toBe("local");
    if (route.kind !== "local") return;
    expect(route.refusal).toBe("unobserved_request");
    expect(route.notify).toBe(false);
    expect(route.explanation).not.toContain("authenticated");
  });

  it("stays local with no cloud configured", async () => {
    expect(routeDownload(input({ cloudAvailable: false }))).toMatchObject({
      kind: "local",
      refusal: "cloud_unavailable",
      notify: false,
    });
  });

  it("honours the always-local setting before anything else", async () => {
    expect(routeDownload(input({ alwaysLocal: true }))).toMatchObject({
      kind: "local",
      refusal: "policy_local_only",
    });
  });

  it("keeps private-network and small downloads local", async () => {
    expect(routeDownload(input({ url: "https://192.168.1.4/big.zip" }))).toMatchObject({
      refusal: "private_host",
    });
    expect(routeDownload(input({ totalBytes: 1024 }))).toMatchObject({ refusal: "too_small" });
  });

  it("refuses non-http schemes", async () => {
    expect(routeDownload(input({ url: "blob:https://example.com/abcd" }))).toMatchObject({
      refusal: "not_http",
    });
  });
});

describe("cloud destination paths", () => {
  it("keeps spaces but never lets a filename escape its directory", async () => {
    expect(safeFilename("my report.pdf")).toBe("my report.pdf");
    expect(safeFilename("../../etc/passwd")).toBe("....etcpasswd");
    expect(safeFilename("")).toBe("download");
    expect(cloudDestPath("a/b/../c.zip")).toBe("/Downloads/ab..c.zip");
  });
});

/* ------------------------------------------------------------------ *
 * The intercept itself, driven through a stub session
 * ------------------------------------------------------------------ */

interface RequestDetails {
  url: string;
  resourceType: string;
  requestHeaders: Record<string, string>;
}

interface DownloadDetails {
  url: string;
  filename: string;
  totalBytes: number;
}

interface Harness {
  /** Drive one space's onBeforeSendHeaders listener. */
  headers: (details: RequestDetails, spaceId?: string) => void;
  /** Drive one space's will-download listener. */
  download: (item: DownloadDetails, spaceId?: string) => Promise<{ cancelled: boolean }>;
  /** Attach the router to one more space, with its own session. */
  attach: (spaceId: string) => void;
  router: DownloadRouter;
  started: Array<{ url: string; destPath: string; spaceId: string }>;
  declined: CloudFetchDeclined[];
}

interface SpaceListeners {
  onHeaders: ((details: unknown, callback: (response: unknown) => void) => void) | null;
  onWillDownload: ((event: { preventDefault: () => void }, item: unknown) => void) | null;
}

function harness(
  options: { cloudAvailable?: boolean; alwaysLocal?: boolean; cloudAccepts?: boolean } = {},
): Harness {
  const spaces = new Map<string, SpaceListeners>();
  const started: Array<{ url: string; destPath: string; spaceId: string }> = [];
  const declined: CloudFetchDeclined[] = [];

  const router = new DownloadRouter({
    cloudAvailable: () => options.cloudAvailable !== false,
    alwaysLocal: () => options.alwaysLocal === true,
    startCloudFetch: (args) => {
      started.push({ url: args.url, destPath: args.destPath, spaceId: args.spaceId });
      return Promise.resolve(options.cloudAccepts !== false);
    },
    onDeclined: (notice) => declined.push(notice),
  });

  const attach = (spaceId: string): void => {
    const listeners: SpaceListeners = { onHeaders: null, onWillDownload: null };
    spaces.set(spaceId, listeners);
    const session = {
      webRequest: {
        onBeforeSendHeaders: (
          listener: (details: unknown, callback: (r: unknown) => void) => void,
        ) => {
          listeners.onHeaders = listener;
        },
      },
      on: (
        _event: string,
        listener: (event: { preventDefault: () => void }, item: unknown) => void,
      ) => {
        listeners.onWillDownload = listener;
      },
    } as unknown as Session;
    router.attachTo(session, spaceId);
  };
  attach(SPACE);

  return {
    headers: (details, spaceId = SPACE) => spaces.get(spaceId)?.onHeaders?.(details, () => undefined),
    download: async (item, spaceId = SPACE) => {
      let cancelled = false;
      let prevented = false;
      const fake = {
        getURL: () => item.url,
        getFilename: () => item.filename,
        getTotalBytes: () => item.totalBytes,
        getState: () => (cancelled ? "cancelled" : "progressing"),
        cancel: () => {
          cancelled = true;
        },
      } as unknown as DownloadItem;
      spaces.get(spaceId)?.onWillDownload?.(
        {
          preventDefault: () => {
            prevented = true;
          },
        },
        fake,
      );
      // The router decides synchronously but only cancels after the cloud
      // answers; flush the microtask queue so the answer has landed.
      await Promise.resolve();
      await Promise.resolve();
      // §8.6 regression guard: the local write must never be killed up front.
      expect(prevented).toBe(false);
      return { cancelled };
    },
    attach,
    router,
    started,
    declined,
  };
}

describe("DownloadRouter will-download intercept", () => {
  it("cancels the local download and starts a cloud fetch for an eligible URL", async () => {
    const h = harness();
    h.headers({
      url: "https://cdn.example.com/big.zip",
      resourceType: "other",
      requestHeaders: { Accept: "*/*" },
    });
    const { cancelled } = await h.download({
      url: "https://cdn.example.com/big.zip",
      filename: "big.zip",
      totalBytes: BIG,
    });
    expect(cancelled).toBe(true);
    expect(h.started).toEqual([
      { url: "https://cdn.example.com/big.zip", destPath: "/Downloads/big.zip", spaceId: SPACE },
    ]);
    expect(h.declined).toEqual([]);
  });

  it("leaves a cookied download to the local DownloadManager and explains it", async () => {
    const h = harness();
    h.headers({
      url: "https://drive.example.com/private.zip",
      resourceType: "mainFrame",
      requestHeaders: { Cookie: "session=abc" },
    });
    const { cancelled } = await h.download({
      url: "https://drive.example.com/private.zip",
      filename: "private.zip",
      totalBytes: BIG,
    });
    expect(cancelled).toBe(false);
    expect(h.started).toEqual([]);
    expect(h.declined).toHaveLength(1);
    expect(h.declined[0]?.reason).toBe("credentialed_request");
  });

  it("stays local — silently — when the request was never observed", async () => {
    const h = harness();
    const { cancelled } = await h.download({
      url: "https://cdn.example.com/unseen.zip",
      filename: "unseen.zip",
      totalBytes: BIG,
    });
    expect(cancelled).toBe(false);
    expect(h.started).toEqual([]);
    expect(h.declined).toEqual([]);
  });

  it("treats an origin that demanded a client certificate as authenticated", async () => {
    const h = harness();
    h.headers({
      url: "https://corp.example.com/report.zip",
      resourceType: "other",
      requestHeaders: { Accept: "*/*" },
    });
    // The certificate challenge arrives on the app, not the session — this is
    // what index.ts forwards from app.on("select-client-certificate").
    h.router.noteClientCertificate("https://corp.example.com/login");

    const { cancelled } = await h.download({
      url: "https://corp.example.com/report.zip",
      filename: "report.zip",
      totalBytes: BIG,
    });
    expect(cancelled).toBe(false);
    expect(h.started).toEqual([]);
    expect(h.declined[0]?.reason).toBe("credentialed_request");
  });

  it("ROUTES ON THE DOWNLOADING SPACE'S OWN OBSERVATION, NOT ANOTHER SPACE'S", async () => {
    // The same URL in two spaces: signed out in one, signed in in the other.
    // The signed-out space's cookie-less load must not clear the signed-in
    // space's download, and vice versa.
    const h = harness();
    h.attach(OTHER_SPACE);
    const url = "https://drive.example.com/report.zip";
    h.headers({ url, resourceType: "mainFrame", requestHeaders: { Accept: "*/*" } }, SPACE);
    h.headers(
      { url, resourceType: "mainFrame", requestHeaders: { Cookie: "session=abc" } },
      OTHER_SPACE,
    );

    const authed = await h.download({ url, filename: "report.zip", totalBytes: BIG }, OTHER_SPACE);
    expect(authed.cancelled).toBe(false);
    expect(h.started).toEqual([]);
    expect(h.declined[0]?.reason).toBe("credentialed_request");

    const anonymous = await h.download({ url, filename: "report.zip", totalBytes: BIG }, SPACE);
    expect(anonymous.cancelled).toBe(true);
    expect(h.started).toEqual([
      { url, destPath: "/Downloads/report.zip", spaceId: SPACE },
    ]);
  });

  it("has nothing to go on when only another space made the request", async () => {
    // Nothing at all was seen in the downloading space — the fail-closed
    // "unobserved" branch, not a borrowed verdict from space-1.
    const h = harness();
    h.attach(OTHER_SPACE);
    const url = "https://cdn.example.com/big.zip";
    h.headers({ url, resourceType: "other", requestHeaders: { Accept: "*/*" } }, SPACE);

    const { cancelled } = await h.download({ url, filename: "big.zip", totalBytes: BIG }, OTHER_SPACE);
    expect(cancelled).toBe(false);
    expect(h.started).toEqual([]);
    expect(h.declined).toEqual([]);
  });

  it("observes an <img>/<video> load that the server answers with an attachment", async () => {
    // These resource types were outside the recorded set, so such a download
    // used to find no observation of itself — or, worse, a stale one left by
    // some other request to the same URL.
    const h = harness();
    for (const resourceType of ["image", "media", "script", "stylesheet", "font"]) {
      const url = `https://cdn.example.com/${resourceType}.bin`;
      h.headers({ url, resourceType, requestHeaders: { Accept: "*/*" } });
      expect((await h.download({ url, filename: `${resourceType}.bin`, totalBytes: BIG })).cancelled).toBe(
        true,
      );
    }
    expect(h.started.map((item) => item.destPath)).toEqual([
      "/Downloads/image.bin",
      "/Downloads/media.bin",
      "/Downloads/script.bin",
      "/Downloads/stylesheet.bin",
      "/Downloads/font.bin",
    ]);
    expect(h.declined).toEqual([]);
  });

  it("still reads the credentials off an attachment-answered media load", async () => {
    const h = harness();
    const url = "https://videos.example.com/private.mp4";
    h.headers({ url, resourceType: "media", requestHeaders: { Cookie: "session=abc" } });
    expect((await h.download({ url, filename: "private.mp4", totalBytes: BIG })).cancelled).toBe(false);
    expect(h.started).toEqual([]);
    expect(h.declined[0]?.reason).toBe("credentialed_request");
  });

  it("keeps a download local when its request type is never recorded", async () => {
    // A beacon cannot become a download, so it is not recorded — and anything
    // that reaches will-download without an observation stays on this Mac.
    const h = harness();
    const url = "https://cdn.example.com/beacon.bin";
    h.headers({ url, resourceType: "ping", requestHeaders: { Accept: "*/*" } });
    const { cancelled } = await h.download({ url, filename: "beacon.bin", totalBytes: BIG });
    expect(cancelled).toBe(false);
    expect(h.started).toEqual([]);
    expect(h.declined).toEqual([]);
  });

  it("does not route anything when there is no cloud to route to", async () => {
    const h = harness({ cloudAvailable: false });
    h.headers({
      url: "https://cdn.example.com/big.zip",
      resourceType: "other",
      requestHeaders: { Accept: "*/*" },
    });
    expect(
      (await h.download({ url: "https://cdn.example.com/big.zip", filename: "big.zip", totalBytes: BIG }))
        .cancelled,
    ).toBe(false);
    expect(h.started).toEqual([]);
  });
});
