import { describe, expect, it, vi } from "vitest";
import type { ControlClient } from "../src/main/control-client";
import { RemoteAssistantSettingsService } from "../src/main/remote-assistant-settings";

describe("remote assistant settings", () => {
  it("reports a signed-out account without attempting control calls", async () => {
    const service = new RemoteAssistantSettingsService(() => null);
    await expect(service.overview()).resolves.toEqual({
      available: false,
      reason: "Sign in to link an external channel.",
      links: [],
      policy: null,
    });
  });

  it("loads links and policy together and refreshes after revocation", async () => {
    const links = [
      {
        id: "link-1",
        channel: "bluebubbles",
        accountId: "bridge-1",
        externalUserId: "+15555550100",
        displayName: "Phone",
        createdAt: "2026-08-22T12:00:00.000Z",
      },
    ];
    const policy = {
      model: "anthropic/claude-sonnet-5",
      enabledToolGroups: ["tabs", "terminal"] as const,
      maxSteps: 40,
      dailyWakeMinutes: 120,
      autoSuspendMinutes: 10,
      updatedAt: null,
    };
    const client = {
      listAssistantLinks: vi.fn().mockResolvedValueOnce(links).mockResolvedValueOnce([]),
      getAssistantPolicy: vi.fn().mockResolvedValue(policy),
      revokeAssistantLink: vi.fn().mockResolvedValue(undefined),
    } as unknown as ControlClient;
    const service = new RemoteAssistantSettingsService(() => client);

    await expect(service.overview()).resolves.toMatchObject({
      available: true,
      links,
      policy,
    });
    await expect(service.revokeLink("link-1")).resolves.toMatchObject({
      available: true,
      links: [],
    });
    expect(client.revokeAssistantLink).toHaveBeenCalledWith("link-1");
  });

  it("turns the account feature gate into an explicit unavailable state", async () => {
    const client = {
      listAssistantLinks: vi
        .fn()
        .mockRejectedValue(new Error("control: 403 feature_required")),
      getAssistantPolicy: vi
        .fn()
        .mockRejectedValue(new Error("control: 403 feature_required")),
    } as unknown as ControlClient;
    const service = new RemoteAssistantSettingsService(() => client);

    await expect(service.overview()).resolves.toMatchObject({
      available: false,
      reason: "Remote assistant access is not enabled for this account.",
    });
  });

  it("delegates an explicit browser-session share", async () => {
    const result = {
      sharedAt: "2026-08-22T13:00:00.000Z",
      spaceId: "space-1",
      spaceName: "Personal",
      cookieCount: 3,
      originCount: 1,
      localStorageItemCount: 2,
    };
    const browserContinuity = {
      shareActiveSpace: vi.fn().mockResolvedValue(result),
    };
    const service = new RemoteAssistantSettingsService(
      () => null,
      browserContinuity,
    );

    await expect(service.shareBrowserSession()).resolves.toEqual(result);
    expect(browserContinuity.shareActiveSpace).toHaveBeenCalledOnce();
  });
});
