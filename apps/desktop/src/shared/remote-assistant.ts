import type { AssistantToolGroupId } from "@suma/assistant-core/tool-groups";

export interface RemoteAssistantLink {
  id: string;
  channel: string;
  accountId: string;
  externalUserId: string;
  displayName: string | null;
  createdAt: string;
}

export interface RemoteAssistantPolicy {
  model: string;
  enabledToolGroups: AssistantToolGroupId[];
  maxSteps: number;
  dailyWakeMinutes: number;
  autoSuspendMinutes: number;
  updatedAt: string | null;
}

export interface RemoteAssistantPolicyPatch {
  model?: string;
  enabledToolGroups?: AssistantToolGroupId[];
  maxSteps?: number;
  dailyWakeMinutes?: number;
  autoSuspendMinutes?: number;
}

export type RemoteAssistantOverview =
  | {
      available: true;
      links: RemoteAssistantLink[];
      policy: RemoteAssistantPolicy;
    }
  | {
      available: false;
      reason: string;
      links: [];
      policy: null;
    };

export interface RemoteAssistantLinkCode {
  code: string;
  expiresAt: string;
}
