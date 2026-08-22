import type {
  RemoteAssistantBrowserShareResult,
  RemoteAssistantLinkCode,
  RemoteAssistantOverview,
  RemoteAssistantPolicy,
  RemoteAssistantPolicyPatch,
} from "../shared/remote-assistant";
import type { ControlClient } from "./control-client";

export class RemoteAssistantSettingsService {
  constructor(
    private readonly control: () => ControlClient | null,
    private readonly browserContinuity?: {
      shareActiveSpace(): Promise<RemoteAssistantBrowserShareResult>;
    },
  ) {}

  async overview(): Promise<RemoteAssistantOverview> {
    const client = this.control();
    if (client === null) return unavailable("Sign in to link an external channel.");
    try {
      const [links, policy] = await Promise.all([
        client.listAssistantLinks(),
        client.getAssistantPolicy(),
      ]);
      return { available: true, links, policy };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("feature_required")) {
        return unavailable("Remote assistant access is not enabled for this account.");
      }
      if (message.includes("assistant_auth_unconfigured")) {
        return unavailable("The remote assistant service is not configured yet.");
      }
      throw error;
    }
  }

  createLinkCode(): Promise<RemoteAssistantLinkCode> {
    return this.requireControl().createAssistantLinkCode();
  }

  async revokeLink(linkId: string): Promise<RemoteAssistantOverview> {
    await this.requireControl().revokeAssistantLink(linkId);
    return this.overview();
  }

  async updatePolicy(
    patch: RemoteAssistantPolicyPatch,
  ): Promise<RemoteAssistantPolicy> {
    return this.requireControl().updateAssistantPolicy(patch);
  }

  shareBrowserSession(): Promise<RemoteAssistantBrowserShareResult> {
    if (this.browserContinuity === undefined) {
      throw new Error("Browser session sharing is not available.");
    }
    return this.browserContinuity.shareActiveSpace();
  }

  private requireControl(): ControlClient {
    const client = this.control();
    if (client === null) throw new Error("Sign in to manage remote assistant access.");
    return client;
  }
}

function unavailable(reason: string): RemoteAssistantOverview {
  return { available: false, reason, links: [], policy: null };
}
