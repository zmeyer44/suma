/**
 * MigrationService — M-0 "My existing workspace becomes Suma" (PRD §5):
 * local import of Chrome/Arc bookmarks into spaces, pinned tabs, and
 * archives, plus the guided sign-in queue.
 *
 * Session import (copying cookies out of Chrome's Safe-Storage-encrypted
 * store, which triggers an OS consent prompt) is a Phase 0 spike and is
 * deliberately NOT implemented — detectSources and bookmark import work
 * fully; the sign-in queue ships regardless (§5).
 */

import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SEED_CORPUS } from "@suma/config";
import type { MigrationResult, MigrationSource, SignInQueueItem } from "../shared/ipc";
import {
  buildSignInQueue,
  parseBookmarksJson,
  type ParsedBookmark,
  type ParsedBookmarkTree,
  type ParsedFolder,
} from "./migration/parse";
import type { SpaceManager } from "./spaces";
import type { WorkspaceStore } from "./workspace-store";

const MAX_IMPORTED_SPACES = 5;
const MAX_PINS_PER_SPACE = 10;
const SIGN_IN_QUEUE_LIMIT = 12;
const IMPORT_COLORS = ["#45d19a", "#e8b45a", "#b78cff", "#4cc3d9", "#ff8cc2"];

export interface MigrationDeps {
  spaces: SpaceManager;
  store: WorkspaceStore;
  onQueueChanged: (queue: SignInQueueItem[]) => void;
}

export class MigrationService {
  constructor(private readonly deps: MigrationDeps) {}

  detectSources(): MigrationSource[] {
    const home = os.homedir();
    const roots: Array<{ browser: "chrome" | "arc"; dir: string }> = [
      { browser: "chrome", dir: path.join(home, "Library", "Application Support", "Google", "Chrome") },
      { browser: "arc", dir: path.join(home, "Library", "Application Support", "Arc", "User Data") },
    ];
    const sources: MigrationSource[] = [];
    for (const root of roots) {
      let entries: string[];
      try {
        entries = readdirSync(root.dir);
      } catch {
        continue;
      }
      for (const name of entries) {
        const profilePath = path.join(root.dir, name);
        if (!existsSync(path.join(profilePath, "Bookmarks"))) continue;
        const parsed = this.readBookmarks(profilePath);
        if (parsed === null) continue;
        sources.push({
          browser: root.browser,
          profileName: name,
          profilePath,
          bookmarkCount: parsed.bookmarks.length,
        });
      }
    }
    return sources;
  }

  import(args: { profilePath: string; browser: "chrome" | "arc" }): MigrationResult {
    const parsed = this.readBookmarks(args.profilePath);
    if (parsed === null) throw new Error("no readable Bookmarks file in that profile");

    // One space per top-level bookmark-bar folder (max 5); a flat bar
    // becomes a single imported space.
    let folders: ParsedFolder[] = parsed.folders
      .filter((folder) => folder.bookmarks.length > 0)
      .slice(0, MAX_IMPORTED_SPACES);
    if (folders.length === 0 && parsed.bookmarks.length > 0) {
      folders = [{ name: args.browser === "chrome" ? "Chrome" : "Arc", bookmarks: parsed.bookmarks }];
    }

    const pinnedBookmarks = new Set<ParsedBookmark>();
    const spaceForBookmark = new Map<ParsedBookmark, string>();
    let spacesCreated = 0;
    let pinnedTabsCreated = 0;
    let firstSpaceId: string | null = null;
    for (const [index, folder] of folders.entries()) {
      const color = IMPORT_COLORS[index % IMPORT_COLORS.length] ?? "#5b8cff";
      const space = this.deps.spaces.create(folder.name, color);
      spacesCreated += 1;
      firstSpaceId ??= space.id;
      for (const [position, bookmark] of folder.bookmarks.slice(0, MAX_PINS_PER_SPACE).entries()) {
        this.deps.store.upsertPin({
          id: randomUUID(),
          spaceId: space.id,
          url: bookmark.url,
          title: bookmark.title,
          position,
        });
        pinnedBookmarks.add(bookmark);
        pinnedTabsCreated += 1;
      }
      for (const bookmark of folder.bookmarks) {
        if (!spaceForBookmark.has(bookmark)) spaceForBookmark.set(bookmark, space.id);
      }
    }

    // Everything not pinned lands in the archive, under its folder's space
    // when it had one.
    let bookmarksImported = 0;
    const fallbackSpaceId = firstSpaceId ?? this.deps.spaces.activeSpaceId;
    if (fallbackSpaceId !== null) {
      const now = Date.now();
      for (const bookmark of parsed.bookmarks) {
        if (pinnedBookmarks.has(bookmark)) continue;
        this.deps.store.addArchive({
          id: randomUUID(),
          spaceId: spaceForBookmark.get(bookmark) ?? fallbackSpaceId,
          url: bookmark.url,
          title: bookmark.title,
          archivedAtMs: now,
        });
        bookmarksImported += 1;
      }
    }

    const signInQueue = buildSignInQueue(parsed.bookmarks, SEED_CORPUS, SIGN_IN_QUEUE_LIMIT);
    this.deps.store.setSignInQueue(signInQueue);
    this.deps.onQueueChanged(signInQueue);
    return { spacesCreated, pinnedTabsCreated, bookmarksImported, signInQueue };
  }

  signInQueue(): SignInQueueItem[] {
    return this.deps.store.signInQueue();
  }

  markSignedIn(domain: string): SignInQueueItem[] {
    const queue = this.deps.store.markSignedIn(domain);
    this.deps.onQueueChanged(queue);
    return queue;
  }

  private readBookmarks(profilePath: string): ParsedBookmarkTree | null {
    try {
      const raw = readFileSync(path.join(profilePath, "Bookmarks"), "utf8");
      return parseBookmarksJson(JSON.parse(raw));
    } catch {
      return null;
    }
  }
}
