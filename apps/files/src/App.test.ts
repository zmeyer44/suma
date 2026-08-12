/**
 * Copy guards.
 *
 * The Files UI carries three §8.6 statements that are easy to lose in a
 * refactor and expensive to lose in production: only `~/cloud` is cloud-native,
 * V1 storage is not end-to-end encrypted, and the cloud only fetches
 * credential-free links. These render the real components (no DOM needed —
 * static markup) and fail if any of the three goes missing or flips meaning.
 */

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PRO_QUOTA_BYTES, type Transfer } from "@suma/protocol";
import { App } from "./App";
import { QuotaMeter } from "./components/QuotaMeter";
import { TransfersPanel } from "./components/TransfersPanel";
import { summarizeQuota } from "./lib/quota";

function textOf(markup: string): string {
  return markup
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

const fetching: Transfer = {
  id: "t1",
  url: "https://releases.example.com/corpus.tar",
  destPath: "/datasets/corpus.tar",
  state: "fetching",
  receivedBytes: 640 * 1024 * 1024,
  totalBytes: 3 * 1024 ** 3,
  originDeviceId: "dev_studio",
  error: null,
  startedAtMs: 1,
  updatedAtMs: 2,
};

describe("App", () => {
  const markup = textOf(renderToStaticMarkup(createElement(App)));

  it("renders without a bridge, and says so", () => {
    expect(markup).toContain("Mock data");
    expect(markup).toContain("Loading your files");
  });

  it("scopes its claim to ~/cloud and never to the whole home directory", () => {
    expect(markup).toContain("~/cloud");
    expect(markup).toContain("the one cloud-native location");
    expect(markup).toMatch(/rest of your home directory/i);
    expect(markup).not.toMatch(/(entire|whole) home directory is (in the )?cloud/i);
  });

  it("states the V1 encryption posture instead of leaving it to be assumed", () => {
    expect(markup).toContain("Not end-to-end encrypted in V1");
    expect(markup).not.toMatch(/\bis end-to-end encrypted\b/i);
  });
});

describe("TransfersPanel", () => {
  const markup = textOf(
    renderToStaticMarkup(
      createElement(TransfersPanel, {
        uploads: [],
        transfers: [fetching],
        context: {
          thisDeviceId: "dev_this",
          devices: [{ id: "dev_studio", name: "Mac Studio" }],
          cloudRoot: "~/cloud",
          endToEndEncrypted: false,
        },
        onCancel: () => {},
        onClearFinishedUploads: () => {},
      }),
    ),
  );

  it("names the device a cloud fetch came from, with its progress", () => {
    expect(markup).toContain("from Mac Studio");
    expect(markup).toContain("640 MB of 3 GB");
  });

  it("says credentialed downloads stay on this Mac", () => {
    expect(markup).toMatch(/public or presigned/i);
    expect(markup).toMatch(/needs a sign-in downloads on this Mac/i);
  });
});

describe("QuotaMeter", () => {
  it("shows the soft block as refused writes, not lost files", () => {
    const markup = textOf(
      renderToStaticMarkup(
        createElement(QuotaMeter, {
          summary: summarizeQuota({ usedBytes: PRO_QUOTA_BYTES, limitBytes: PRO_QUOTA_BYTES }),
        }),
      ),
    );
    expect(markup).toContain("100 GB of 100 GB");
    expect(markup).toContain("Everything already here stays available");
    expect(markup).not.toMatch(/delet|remov/i);
  });
});
