import {
  isAssistantToolGroupId,
  type AssistantTaskAuthorization,
  type AssistantToolGroupId,
  type InboundAssistantMessage,
} from "@suma/assistant-core";
import { appendServicePath } from "./url";

export type LinkCommandResult =
  | { kind: "linked"; authorization: AssistantTaskAuthorization }
  | { kind: "invalid" }
  | { kind: "conflict" }
  | { kind: "disabled" };

export interface AssistantLinkService {
  resolve(
    message: InboundAssistantMessage,
  ): Promise<AssistantTaskAuthorization | null>;
  redeem(
    message: InboundAssistantMessage,
    code: string,
  ): Promise<LinkCommandResult>;
  revoke(message: InboundAssistantMessage): Promise<boolean>;
}

export interface ControlAssistantLinkClientOptions {
  controlUrl: string;
  serviceToken: string;
  fetch?: typeof fetch;
}

export interface AssistantMachineSession {
  agentAddress: string;
  capabilityToken: string;
  exp: number;
  state: "running" | "resuming";
}

/** Service-authenticated client for control's channel-link authority. */
export class ControlAssistantLinkClient implements AssistantLinkService {
  readonly #resolveUrl: URL;
  readonly #redeemUrl: URL;
  readonly #revokeUrl: URL;
  readonly #machineSessionUrl: URL;
  readonly #serviceToken: string;
  readonly #fetch: typeof fetch;

  constructor(options: ControlAssistantLinkClientOptions) {
    this.#resolveUrl = appendServicePath(
      options.controlUrl,
      "v1/assistant/links/resolve",
    );
    this.#redeemUrl = appendServicePath(
      options.controlUrl,
      "v1/assistant/link-redeem",
    );
    this.#revokeUrl = appendServicePath(
      options.controlUrl,
      "v1/assistant/links/revoke",
    );
    this.#machineSessionUrl = appendServicePath(
      options.controlUrl,
      "v1/assistant/machine-session",
    );
    this.#serviceToken = options.serviceToken;
    this.#fetch = options.fetch ?? fetch;
  }

  async resolve(
    message: InboundAssistantMessage,
  ): Promise<AssistantTaskAuthorization | null> {
    const response = await this.#post(this.#resolveUrl, identityFor(message));
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(
        `assistant link resolution failed with HTTP ${String(response.status)}`,
      );
    }
    return parseAuthorization(await response.json());
  }

  async redeem(
    message: InboundAssistantMessage,
    code: string,
  ): Promise<LinkCommandResult> {
    const response = await this.#post(this.#redeemUrl, {
      code,
      ...identityFor(message),
    });
    if (response.status === 401) return { kind: "invalid" };
    if (response.status === 409) return { kind: "conflict" };
    if (response.status === 403) return { kind: "disabled" };
    if (!response.ok) {
      throw new Error(
        `assistant link redemption failed with HTTP ${String(response.status)}`,
      );
    }
    return {
      kind: "linked",
      authorization: parseAuthorization(await response.json()),
    };
  }

  async revoke(message: InboundAssistantMessage): Promise<boolean> {
    const response = await this.#post(this.#revokeUrl, identityFor(message));
    if (response.status === 404) return false;
    if (!response.ok) {
      throw new Error(
        `assistant link revocation failed with HTTP ${String(response.status)}`,
      );
    }
    return true;
  }

  async machineSession(
    authorization: AssistantTaskAuthorization,
  ): Promise<AssistantMachineSession> {
    const response = await this.#post(this.#machineSessionUrl, {
      userId: authorization.userId,
      linkId: authorization.linkId,
    });
    if (!response.ok) {
      throw new Error(
        `assistant machine session failed with HTTP ${String(response.status)}`,
      );
    }
    const value = await response.json();
    if (!isRecord(value)) throw malformedMachineSession();
    const state = value["state"];
    if (
      typeof value["agentAddress"] !== "string" ||
      typeof value["capabilityToken"] !== "string" ||
      typeof value["exp"] !== "number" ||
      (state !== "running" && state !== "resuming")
    ) {
      throw malformedMachineSession();
    }
    return {
      agentAddress: value["agentAddress"],
      capabilityToken: value["capabilityToken"],
      exp: value["exp"],
      state,
    };
  }

  #post(url: URL, body: unknown): Promise<Response> {
    return this.#fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.#serviceToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  }
}

function identityFor(message: InboundAssistantMessage) {
  return {
    channel: message.channel,
    accountId: message.accountId,
    externalUserId: message.externalUserId,
  };
}

function parseAuthorization(value: unknown): AssistantTaskAuthorization {
  if (!isRecord(value)) throw malformed();
  const link = value["link"];
  const policy = value["policy"];
  if (!isRecord(link) || !isRecord(policy)) throw malformed();
  const groups = policy["enabledToolGroups"];
  if (
    typeof link["id"] !== "string" ||
    typeof link["userId"] !== "string" ||
    typeof policy["model"] !== "string" ||
    !isToolGroupArray(groups) ||
    !isBoundedInteger(policy["maxSteps"], 1, 80) ||
    !isBoundedInteger(policy["dailyWakeMinutes"], 0, 1_440) ||
    !isBoundedInteger(policy["autoSuspendMinutes"], 1, 120)
  ) {
    throw malformed();
  }
  return {
    userId: link["userId"],
    linkId: link["id"],
    policy: {
      model: policy["model"],
      enabledToolGroups: groups,
      maxSteps: policy["maxSteps"],
      dailyWakeMinutes: policy["dailyWakeMinutes"],
      autoSuspendMinutes: policy["autoSuspendMinutes"],
    },
  };
}

function isToolGroupArray(value: unknown): value is AssistantToolGroupId[] {
  return (
    Array.isArray(value) &&
    value.every(
      (group) => typeof group === "string" && isAssistantToolGroupId(group),
    )
  );
}

function isBoundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= minimum &&
    value <= maximum
  );
}

function malformed(): Error {
  return new Error("control returned malformed assistant authorization");
}

function malformedMachineSession(): Error {
  return new Error("control returned malformed assistant machine session");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
