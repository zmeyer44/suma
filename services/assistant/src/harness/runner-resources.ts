import { TcpAgentClient, type AgentLink } from "@suma/agent-client";
import type { BrowserBackend } from "@suma/assistant-core/browser";
import type { AssistantTaskRecord } from "@suma/assistant-core/channel";
import type { BrowserAuthProvider } from "../browser/auth-provider";
import { EmptyBrowserAuthProvider } from "../browser/auth-provider";
import { SafeBrowserNetworkPolicy } from "../browser/network-policy";
import {
  PlaywrightBrowserBackend,
  PlaywrightBrowserRuntime,
} from "../browser/playwright-backend";
import {
  EncryptedFileBrowserSessionStore,
  type BrowserSessionStore,
} from "../browser/session-store";
import type { AssistantMachineSession } from "../control-client";
import type { RemoteAssistantResources } from "./remote-tool-provider";

const SESSION_SPACE = "remote";
const CONNECTION_TIMEOUT_MS = 45_000;
const TOKEN_REFRESH_MARGIN_SECONDS = 45;

export interface MachineSessionIssuer {
  machineSession(
    authorization: AssistantTaskRecord["authorization"],
  ): Promise<AssistantMachineSession>;
}

interface PooledAgent {
  link: TcpAgentClient;
  address: string;
  exp: number;
}

/** Per-user resources owned by the private runner process. */
export class ProductionAssistantResources implements RemoteAssistantResources {
  readonly runtime: PlaywrightBrowserRuntime;
  readonly store: BrowserSessionStore;
  readonly #control: MachineSessionIssuer;
  readonly #authProviderForUser: (userId: string) => BrowserAuthProvider;
  readonly #browsers = new Map<string, PlaywrightBrowserBackend>();
  readonly #agents = new Map<string, PooledAgent>();

  constructor(options: {
    control: MachineSessionIssuer;
    dataDirectory: string;
    masterKey: Uint8Array;
    executablePath?: string;
    runtime?: PlaywrightBrowserRuntime;
    store?: BrowserSessionStore;
    authProviderForUser?: (userId: string) => BrowserAuthProvider;
  }) {
    this.#control = options.control;
    this.runtime =
      options.runtime ??
      new PlaywrightBrowserRuntime({ executablePath: options.executablePath });
    this.store =
      options.store ??
      new EncryptedFileBrowserSessionStore(
        `${options.dataDirectory}/browser-sessions`,
        options.masterKey,
      );
    this.#authProviderForUser =
      options.authProviderForUser ?? (() => new EmptyBrowserAuthProvider());
  }

  browserForTask(task: AssistantTaskRecord): Promise<BrowserBackend> {
    const userId = task.authorization.userId;
    let browser = this.#browsers.get(userId);
    if (browser === undefined) {
      browser = new PlaywrightBrowserBackend({
        runtime: this.runtime,
        sessionKey: { userId, spaceId: SESSION_SPACE },
        store: this.store,
        networkPolicy: new SafeBrowserNetworkPolicy(),
        authProvider: this.#authProviderForUser(userId),
      });
      this.#browsers.set(userId, browser);
    }
    return Promise.resolve(browser);
  }

  async agentForTask(task: AssistantTaskRecord): Promise<AgentLink> {
    const userId = task.authorization.userId;
    const current = this.#agents.get(userId);
    const now = Math.floor(Date.now() / 1_000);
    if (
      current !== undefined &&
      current.link.connected() &&
      current.exp > now + TOKEN_REFRESH_MARGIN_SECONDS
    ) {
      return current.link;
    }

    const session = await this.#control.machineSession(task.authorization);
    const address = normalizeAgentAddress(session.agentAddress);
    const replacement = new TcpAgentClient(address, {
      capabilityToken: session.capabilityToken,
    });
    try {
      await waitForConnection(replacement);
    } catch (error) {
      replacement.stop();
      throw error;
    }
    current?.link.stop();
    this.#agents.set(userId, {
      link: replacement,
      address,
      exp: session.exp,
    });
    return replacement;
  }

  async close(): Promise<void> {
    for (const browser of this.#browsers.values()) await browser.close();
    this.#browsers.clear();
    for (const agent of this.#agents.values()) agent.link.stop();
    this.#agents.clear();
    await this.runtime.close();
  }
}

function normalizeAgentAddress(value: string): string {
  return value.includes("://") ? value : `tcp://${value}`;
}

function waitForConnection(link: AgentLink): Promise<void> {
  if (link.connected()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      if (error === undefined) resolve();
      else reject(error);
    };
    const unsubscribe = link.onConnectionChanged((up) => {
      if (up) finish();
    });
    const timer = setTimeout(
      () => finish(new Error("timed out waiting for the user's computer")),
      CONNECTION_TIMEOUT_MS,
    );
    timer.unref?.();
  });
}
