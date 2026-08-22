import type { AgentLink } from "@suma/agent-client";
import {
  createBrowserToolSet,
  type BrowserBackend,
} from "@suma/assistant-core/browser";
import type { AssistantTaskRecord } from "@suma/assistant-core/channel";
import { createComputerToolSet } from "@suma/assistant-core/computer";
import type { ToolSet } from "ai";
import { RemoteComputerBackend } from "../computer";

export interface RemoteAssistantResources {
  browserForTask(task: AssistantTaskRecord): Promise<BrowserBackend>;
  agentForTask(task: AssistantTaskRecord): Promise<AgentLink>;
  workspaceRootForTask?(task: AssistantTaskRecord): string | undefined;
}

/** Composes the complete v1 tool surface without binding it to a channel. */
export class RemoteAssistantToolProvider {
  readonly #computers = new WeakMap<AgentLink, RemoteComputerBackend>();

  constructor(private readonly resources: RemoteAssistantResources) {}

  async toolsForTask(task: AssistantTaskRecord): Promise<ToolSet> {
    const browser = await this.resources.browserForTask(task);
    const groups = new Set(task.authorization.policy.enabledToolGroups);
    if (
      !groups.has("terminal") &&
      !groups.has("files") &&
      !groups.has("memory")
    ) {
      return createBrowserToolSet(browser);
    }
    const link = await this.resources.agentForTask(task);
    let computer = this.#computers.get(link);
    if (computer === undefined) {
      computer = new RemoteComputerBackend({
        link,
        workspaceRoot: this.resources.workspaceRootForTask?.(task),
      });
      this.#computers.set(link, computer);
    }
    return {
      ...createBrowserToolSet(browser),
      ...createComputerToolSet(computer),
    };
  }
}
