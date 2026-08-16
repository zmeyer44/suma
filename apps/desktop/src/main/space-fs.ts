/**
 * SpaceFsService — each space's presence in the shared filesystem.
 *
 * One folder per space under the account's computer root (~/cloud on the
 * VM, ~/Suma in local mode), bound lazily: the first time anything needs a
 * space's folder, its name is sanitized, made collision-free against the
 * other bindings, and persisted in the SYNCED WorkspaceStore so every
 * device agrees forever after.
 *
 * Renames move the folder best-effort (the binding survives a failed move —
 * display name and folder may diverge, which beats losing track of files).
 * Deleting a space drops only the binding: user data outlives the persona
 * that named it.
 */

import { normalizeVfsPath } from "@suma/protocol";
import type { AgentLink } from "./compute/agent-client";
import { pickSpaceFolder } from "./space-folders";

export const SPACE_DOWNLOADS_DIR = "Downloads";

export interface SpaceFsDeps {
  link: AgentLink;
  store: {
    spaceFolders(): Record<string, string>;
    setSpaceFolder(spaceId: string, folder: string): void;
    removeSpaceFolder(spaceId: string): void;
  };
  /** Space display name lookup, for first-touch derivation. */
  spaceName: (spaceId: string) => string | null;
}

export class SpaceFsService {
  constructor(private readonly deps: SpaceFsDeps) {}

  /**
   * The space's folder name, binding it now if this is the first touch.
   * Synchronous on purpose — the downloads path is chosen inside Electron's
   * will-download handler, which cannot await.
   */
  folderFor(spaceId: string): string {
    const existing = this.deps.store.spaceFolders()[spaceId];
    if (existing !== undefined) return existing;
    const name = this.deps.spaceName(spaceId) ?? "Space";
    const folder = pickSpaceFolder(this.deps.store.spaceFolders(), spaceId, name);
    this.deps.store.setSpaceFolder(spaceId, folder);
    return folder;
  }

  /** Ensure the space's folder exists on the shared FS (mkdir is idempotent). */
  async ensureSpaceDir(spaceId: string): Promise<string> {
    const folder = this.folderFor(spaceId);
    await this.deps.link.vfs({ t: "vfs.mkdir", path: `/${folder}` });
    return folder;
  }

  /** Ensure <space>/Downloads exists; returns the folder-relative wire path. */
  async ensureDownloadsDir(spaceId: string): Promise<string> {
    const folder = this.folderFor(spaceId);
    const path = `/${folder}/${SPACE_DOWNLOADS_DIR}`;
    await this.deps.link.vfs({ t: "vfs.mkdir", path });
    return path;
  }

  /**
   * Space renamed: move the folder when the new name is free, update the
   * binding only when the move succeeded. Every failure leaves the old
   * binding standing — files never go missing over a cosmetic rename.
   */
  async onSpaceRenamed(spaceId: string, newName: string): Promise<void> {
    const current = this.deps.store.spaceFolders()[spaceId];
    if (current === undefined) return; // never bound — nothing on disk yet
    const next = pickSpaceFolder(this.deps.store.spaceFolders(), spaceId, newName);
    if (next === current) return;
    if (normalizeVfsPath(current) === null || normalizeVfsPath(next) === null) return;
    const resp = await this.deps.link.vfs({
      t: "vfs.rename",
      from: `/${current}`,
      to: `/${next}`,
    });
    if (resp.t === "vfs.renamed") {
      this.deps.store.setSpaceFolder(spaceId, next);
    } else if (resp.t === "error" && resp.code === "vfs_not_found") {
      // Nothing on disk yet (space never touched the FS) — rebind freely.
      this.deps.store.setSpaceFolder(spaceId, next);
    }
    // Any other refusal (target exists, link down): keep the old binding.
  }

  /** Space deleted: drop the binding, keep the folder and everything in it. */
  onSpaceRemoved(spaceId: string): void {
    this.deps.store.removeSpaceFolder(spaceId);
  }
}
