import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EncryptedFileBrowserSessionStore,
  type BrowserSessionKey,
  type BrowserStorageState,
} from "../src/browser/session-store";

describe("encrypted browser session store", () => {
  it("round-trips account state without writing cookie values in plaintext", async () => {
    const directory = await mkdtemp(join(tmpdir(), "suma-browser-store-"));
    const store = new EncryptedFileBrowserSessionStore(
      directory,
      randomBytes(32),
    );
    const key: BrowserSessionKey = { userId: "user/one", spaceId: "space/one" };
    const state: BrowserStorageState = {
      cookies: [
        {
          name: "session",
          value: "top-secret-cookie",
          domain: "example.com",
          path: "/",
          expires: -1,
          httpOnly: true,
          secure: true,
          sameSite: "Lax",
        },
      ],
      origins: [],
    };

    await store.save(key, state);
    await expect(store.load(key)).resolves.toEqual(state);

    const names = await import("node:fs/promises").then((fs) =>
      fs.readdir(directory),
    );
    expect(names).toHaveLength(1);
    const path = join(directory, names[0] ?? "missing");
    expect(await readFile(path, "utf8")).not.toContain("top-secret-cookie");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});
