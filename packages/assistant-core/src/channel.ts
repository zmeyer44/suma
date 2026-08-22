import type { AssistantToolGroupId } from "./tool-groups";

export interface ExternalAttachment {
  id: string;
  mediaType: string;
  filename?: string;
  /** URL known only to the adapter. It may require channel authentication. */
  sourceUrl?: string;
}

/** A normalized message accepted by the channel-neutral assistant runtime. */
export interface InboundAssistantMessage {
  /** Stable channel delivery id used for webhook deduplication. */
  deliveryId: string;
  channel: string;
  accountId: string;
  externalThreadId: string;
  externalUserId: string;
  text: string;
  attachments: ExternalAttachment[];
  receivedAt: string;
  replyToDeliveryId?: string;
}

export interface AssistantDestination {
  channel: string;
  accountId: string;
  externalThreadId: string;
}

export type OutboundAssistantMessage =
  | { kind: "text"; text: string }
  | {
      kind: "attachment";
      text?: string;
      filename: string;
      mediaType: string;
      data: Uint8Array;
    }
  | { kind: "status"; text: string };

/** Channel implementations own delivery details, not agent behavior. */
export interface AssistantChannelAdapter {
  readonly channel: string;
  send(
    destination: AssistantDestination,
    message: OutboundAssistantMessage,
  ): Promise<void>;
}

export type AssistantTaskStatus =
  | "queued"
  | "running"
  | "waiting_for_approval"
  | "succeeded"
  | "failed";

/** Control-plane decision attached before an external message is queued. */
export interface AssistantTaskAuthorization {
  userId: string;
  linkId: string;
  policy: {
    model: string;
    enabledToolGroups: AssistantToolGroupId[];
    maxSteps: number;
    dailyWakeMinutes: number;
    autoSuspendMinutes: number;
  };
}

export interface AssistantTaskRecord {
  id: string;
  dedupeKey: string;
  conversationId: string;
  authorization: AssistantTaskAuthorization;
  message: InboundAssistantMessage;
  status: AssistantTaskStatus;
  createdAt: string;
  updatedAt: string;
  error?: string;
}

export interface AssistantTaskStore {
  enqueue(task: AssistantTaskRecord): Promise<AssistantTaskRecord>;
  claimNext(): Promise<AssistantTaskRecord | null>;
  update(
    id: string,
    patch: Pick<AssistantTaskRecord, "status" | "updatedAt"> & {
      error?: string;
    },
  ): Promise<void>;
  findByDedupeKey(dedupeKey: string): Promise<AssistantTaskRecord | null>;
  /** Requeue work that was running when the service process stopped. */
  recoverInterrupted(): Promise<number>;
}

/** The existing desktop harness and the remote harness implement this seam. */
export interface AssistantHarness {
  run(
    task: AssistantTaskRecord,
    emit: (message: OutboundAssistantMessage) => Promise<void>,
  ): Promise<void>;
}
