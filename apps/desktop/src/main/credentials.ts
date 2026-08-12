/**
 * CredentialsService — the 1Password CLI (`op`) bridge (PRD §8.1 credential
 * ship-blocker, option 1). Best-effort, clearly scoped: `op` is spawned per
 * lookup, the vault is never stored, and if the CLI is missing or locked the
 * feature degrades to guidance. The 1Password native-messaging/SDK
 * integration is the eventual path; this ships the one reliable flow.
 */

import { execFile } from "node:child_process";
import type { CredentialItem, CredentialProviderStatus } from "../shared/ipc";
import {
  buildFillScript,
  credentialItemsForHost,
  opGetArgs,
  OP_LIST_ARGS,
  OP_VERSION_ARGS,
  parseOpFields,
} from "./credentials-core";
import type { TabManager } from "./tabs";

const OP_TIMEOUT_MS = 15_000;
const OP_MAX_BUFFER = 4 * 1024 * 1024;

export class CredentialsService {
  constructor(private readonly tabs: TabManager) {}

  /** `op --version` spawns without any auth prompt — a pure availability probe. */
  async status(): Promise<CredentialProviderStatus> {
    try {
      const version = (await this.op(OP_VERSION_ARGS)).trim();
      return { provider: "1password-cli", available: true, detail: `op ${version}` };
    } catch {
      return {
        provider: "none",
        available: false,
        detail:
          "1Password CLI (op) not found. Install it and enable the desktop-app integration to search and fill credentials.",
      };
    }
  }

  async search(host: string): Promise<CredentialItem[]> {
    try {
      const out = await this.op(OP_LIST_ARGS);
      return credentialItemsForHost(JSON.parse(out), host);
    } catch {
      // Not installed or not signed in — degrade to an empty list.
      return [];
    }
  }

  /** Fill username+password into the focused login form of the tab. */
  async fill(tabId: string, itemId: string): Promise<{ ok: boolean }> {
    const wc = this.tabs.webContentsFor(tabId);
    if (wc === null) return { ok: false };
    let fields: { username: string; password: string } | null;
    try {
      fields = parseOpFields(JSON.parse(await this.op(opGetArgs(itemId))));
    } catch {
      return { ok: false };
    }
    if (fields === null) return { ok: false };
    try {
      const filled = (await wc.executeJavaScript(
        buildFillScript(fields.username, fields.password),
        true,
      )) as unknown;
      return { ok: filled === true };
    } catch {
      return { ok: false };
    }
  }

  private op(args: readonly string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        "op",
        [...args],
        { timeout: OP_TIMEOUT_MS, maxBuffer: OP_MAX_BUFFER },
        (err, stdout) => {
          if (err !== null) reject(err);
          else resolve(stdout);
        },
      );
    });
  }
}
