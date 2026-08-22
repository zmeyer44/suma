import type {
  AssistantTaskAuthorization,
  InboundAssistantMessage,
} from "@suma/assistant-core";
import { describe, expect, it } from "vitest";
import { ControlAssistantLinkClient } from "../src/control-client";

const message: InboundAssistantMessage = {
  deliveryId: "delivery-1",
  channel: "bluebubbles",
  accountId: "personal",
  externalThreadId: "iMessage;-;+15555550123",
  externalUserId: "+15555550123",
  text: "hello",
  attachments: [],
  receivedAt: new Date(0).toISOString(),
};

const controlResponse = {
  link: { id: "link-1", userId: "user-1" },
  policy: {
    model: "provider/model",
    enabledToolGroups: ["tabs", "navigate", "read", "interact"],
    maxSteps: 20,
    dailyWakeMinutes: 60,
    autoSuspendMinutes: 10,
  } as AssistantTaskAuthorization["policy"],
};

describe("control assistant link client", () => {
  it("preserves a mounted control path and parses authorization", async () => {
    let request: Request | undefined;
    const client = new ControlAssistantLinkClient({
      controlUrl: "https://control.example/mounted/",
      serviceToken: "service-token",
      fetch: (input, init) => {
        request = new Request(input, init);
        return Promise.resolve(Response.json(controlResponse));
      },
    });

    await expect(client.resolve(message)).resolves.toEqual({
      userId: "user-1",
      linkId: "link-1",
      policy: controlResponse.policy,
    });
    expect(request?.url).toBe(
      "https://control.example/mounted/v1/assistant/links/resolve",
    );
    expect(request?.headers.get("authorization")).toBe("Bearer service-token");
    await expect(request?.json()).resolves.toEqual({
      channel: "bluebubbles",
      accountId: "personal",
      externalUserId: "+15555550123",
    });
  });

  it("treats a missing or revoked identity as unlinked", async () => {
    const client = new ControlAssistantLinkClient({
      controlUrl: "https://control.example/",
      serviceToken: "service-token",
      fetch: () =>
        Promise.resolve(Response.json({ error: "not_linked" }, { status: 404 })),
    });

    await expect(client.resolve(message)).resolves.toBeNull();
    await expect(client.revoke(message)).resolves.toBe(false);
  });

  it("fails closed on malformed policy responses", async () => {
    const client = new ControlAssistantLinkClient({
      controlUrl: "https://control.example/",
      serviceToken: "service-token",
      fetch: () =>
        Promise.resolve(
          Response.json({
            ...controlResponse,
            policy: { ...controlResponse.policy, enabledToolGroups: ["root"] },
          }),
        ),
    });

    await expect(client.resolve(message)).rejects.toThrow(
      "malformed assistant authorization",
    );
  });

  it("requests a short-lived authenticated VM session for the linked user", async () => {
    let request: Request | undefined;
    const client = new ControlAssistantLinkClient({
      controlUrl: "https://control.example/mounted/",
      serviceToken: "service-token",
      fetch: (input, init) => {
        request = new Request(input, init);
        return Promise.resolve(
          Response.json({
            agentAddress: "vm.internal:2222",
            capabilityToken: "header.payload.signature",
            exp: 2_000,
            state: "running",
          }),
        );
      },
    });

    const authorization: AssistantTaskAuthorization = {
      userId: "user-1",
      linkId: "link-1",
      policy: controlResponse.policy,
    };
    await expect(client.machineSession(authorization)).resolves.toEqual({
      agentAddress: "vm.internal:2222",
      capabilityToken: "header.payload.signature",
      exp: 2_000,
      state: "running",
    });
    expect(request?.url).toBe(
      "https://control.example/mounted/v1/assistant/machine-session",
    );
    await expect(request?.json()).resolves.toEqual({
      userId: "user-1",
      linkId: "link-1",
    });
  });
});
