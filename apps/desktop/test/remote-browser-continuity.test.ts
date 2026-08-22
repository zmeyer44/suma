import type { Cookie, Session, WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";
import type { ControlClient } from "../src/main/control-client";
import {
  captureBrowserStorageState,
  RemoteBrowserContinuityService,
  type BrowserContinuityDependencies,
} from "../src/main/remote-browser-continuity";

describe("remote browser continuity", () => {
  it("maps cookies and captures local storage from distinct live origins", async () => {
    const cookies: Cookie[] = [
      {
        name: "session",
        value: "signed-in",
        domain: ".example.com",
        path: "/",
        expirationDate: 2_000,
        httpOnly: true,
        secure: true,
        sameSite: "no_restriction",
      },
      {
        name: "preference",
        value: "compact",
        domain: "app.example",
        path: "/settings",
        session: true,
        sameSite: "unspecified",
      },
    ];
    const session = {
      cookies: { get: vi.fn().mockResolvedValue(cookies) },
    } as unknown as Pick<Session, "cookies">;
    const first = webContentsResult({
      origin: "https://app.example",
      localStorage: [{ name: "workspace", value: "primary" }],
    });
    const duplicate = webContentsResult({
      origin: "https://app.example",
      localStorage: [{ name: "workspace", value: "updated" }],
    });
    const failed = {
      getURL: () => "https://failed.example",
      executeJavaScript: vi.fn().mockRejectedValue(new Error("tab navigated")),
    } as unknown as Pick<WebContents, "executeJavaScript" | "getURL">;
    const internal = {
      getURL: () => "suma://settings/assistant",
      executeJavaScript: vi.fn().mockRejectedValue(new Error("must not run")),
    } as unknown as Pick<WebContents, "executeJavaScript" | "getURL">;

    await expect(
      captureBrowserStorageState(session, [
        first,
        null,
        failed,
        internal,
        duplicate,
      ]),
    ).resolves.toEqual({
      cookies: [
        {
          name: "session",
          value: "signed-in",
          domain: ".example.com",
          path: "/",
          expires: 2_000,
          httpOnly: true,
          secure: true,
          sameSite: "None",
        },
        {
          name: "preference",
          value: "compact",
          domain: "app.example",
          path: "/settings",
          expires: -1,
          httpOnly: false,
          secure: false,
          sameSite: "Lax",
        },
      ],
      origins: [
        {
          origin: "https://app.example",
          localStorage: [{ name: "workspace", value: "updated" }],
        },
      ],
    });
    expect(internal.executeJavaScript).not.toHaveBeenCalled();
  });

  it("uploads with a one-use ticket and never exposes the device bearer", async () => {
    const control = {
      createAssistantBrowserSessionTicket: vi.fn().mockResolvedValue({
        ticket: "one-use-ticket",
        expiresAt: "2026-08-22T13:05:00.000Z",
        uploadUrl: "https://assistant.example/mounted/v1/browser-sessions/import",
      }),
    } as unknown as ControlClient;
    let uploaded: Request | undefined;
    const deps = dependencies(control, async (input, init) => {
      uploaded = new Request(input, init);
      return Response.json({ imported: true }, { status: 201 });
    });
    const service = new RemoteBrowserContinuityService(deps);

    await expect(service.shareActiveSpace()).resolves.toEqual({
      sharedAt: "2026-08-22T13:00:00.000Z",
      spaceId: "space-1",
      spaceName: "Personal",
      cookieCount: 1,
      originCount: 1,
      localStorageItemCount: 1,
    });
    expect(uploaded?.url).toBe(
      "https://assistant.example/mounted/v1/browser-sessions/import",
    );
    expect(uploaded?.redirect).toBe("error");
    expect(uploaded?.headers.get("authorization")).toBeNull();
    await expect(uploaded?.json()).resolves.toEqual({
      ticket: "one-use-ticket",
      state: {
        cookies: [
          {
            name: "session",
            value: "signed-in",
            domain: "app.example",
            path: "/",
            expires: -1,
            httpOnly: true,
            secure: true,
            sameSite: "Lax",
          },
        ],
        origins: [
          {
            origin: "https://app.example",
            localStorage: [{ name: "workspace", value: "primary" }],
          },
        ],
      },
    });
  });

  it("rejects a non-loopback plaintext upload URL before sending state", async () => {
    const control = {
      createAssistantBrowserSessionTicket: vi.fn().mockResolvedValue({
        ticket: "one-use-ticket",
        expiresAt: "2026-08-22T13:05:00.000Z",
        uploadUrl: "http://assistant.example/v1/browser-sessions/import",
      }),
    } as unknown as ControlClient;
    const fetchMock = vi.fn<typeof fetch>();
    const service = new RemoteBrowserContinuityService(
      dependencies(control, fetchMock),
    );

    await expect(service.shareActiveSpace()).rejects.toThrow("must use HTTPS");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not replace a remote session with an empty desktop space", async () => {
    const control = {
      createAssistantBrowserSessionTicket: vi.fn(),
    } as unknown as ControlClient;
    const service = new RemoteBrowserContinuityService({
      control: () => control,
      spaces: {
        activeSpaceId: "space-1",
        get: () => ({ id: "space-1", name: "Personal" }),
        sessionFor: () =>
          ({
            cookies: { get: vi.fn().mockResolvedValue([]) },
          }) as unknown as Pick<Session, "cookies">,
      },
      tabs: {
        list: () => [],
        webContentsFor: () => null,
      },
    });

    await expect(service.shareActiveSpace()).rejects.toThrow(
      "no browser sessions to share",
    );
    expect(control.createAssistantBrowserSessionTicket).not.toHaveBeenCalled();
  });
});

function dependencies(
  control: ControlClient,
  fetchImpl: typeof fetch,
): BrowserContinuityDependencies {
  const session = {
    cookies: {
      get: vi.fn().mockResolvedValue([
        {
          name: "session",
          value: "signed-in",
          domain: "app.example",
          path: "/",
          session: true,
          httpOnly: true,
          secure: true,
          sameSite: "lax",
        } satisfies Cookie,
      ]),
    },
  } as unknown as Pick<Session, "cookies">;
  return {
    control: () => control,
    spaces: {
      activeSpaceId: "space-1",
      get: () => ({ id: "space-1", name: "Personal" }),
      sessionFor: () => session,
    },
    tabs: {
      list: () => [{ id: "tab-1" }],
      webContentsFor: () =>
        webContentsResult({
          origin: "https://app.example",
          localStorage: [{ name: "workspace", value: "primary" }],
        }),
    },
    fetch: fetchImpl,
    now: () => new Date("2026-08-22T13:00:00.000Z"),
  };
}

function webContentsResult(
  value: unknown,
): Pick<WebContents, "executeJavaScript" | "getURL"> {
  const url =
    typeof value === "object" &&
    value !== null &&
    "origin" in value &&
    typeof value.origin === "string"
      ? `${value.origin}/page`
      : "https://example.test/page";
  return {
    getURL: () => url,
    executeJavaScript: vi.fn().mockResolvedValue(value),
  } as unknown as Pick<WebContents, "executeJavaScript" | "getURL">;
}
