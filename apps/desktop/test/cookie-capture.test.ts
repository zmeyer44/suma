import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { SpaceSyncEngine } from "@suma/sync-engine";
import type { Cookie, Session } from "electron";
import { attachCookieCapture } from "../src/main/sync/capture";

function cookie(name: string): Cookie {
  return {
    name,
    value: `${name}-value`,
    domain: ".google.com",
    hostOnly: false,
    path: "/",
    secure: true,
    httpOnly: true,
    session: true,
    sameSite: "lax",
  };
}

describe("cookie capture ordering", () => {
  it("serializes a same-response cookie burst and exposes a drain fence", async () => {
    const cookies = new EventEmitter();
    let releaseFirst: (() => void) | undefined;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const localChange = vi
      .fn()
      .mockImplementationOnce(async () => first)
      .mockResolvedValue(null);
    const errors: unknown[] = [];
    const capture = attachCookieCapture(
      { cookies } as unknown as Session,
      "space-1",
      { localChange } as unknown as SpaceSyncEngine,
      () => false,
      (error) => errors.push(error),
    );

    cookies.emit("changed", {}, cookie("SID"), "explicit", false);
    cookies.emit("changed", {}, cookie("HSID"), "explicit", false);
    await Promise.resolve();

    // The second Google cookie cannot start another same-origin lease request
    // until the first mutation has finished.
    expect(localChange).toHaveBeenCalledTimes(1);
    releaseFirst?.();
    await capture.drain();

    expect(localChange).toHaveBeenCalledTimes(2);
    expect(localChange.mock.calls.map((call) => call[0].name)).toEqual([
      "SID",
      "HSID",
    ]);
    expect(errors).toEqual([]);
    capture.detach();
  });
});
