/**
 * FavoritesService — the favorite-sites list (shared/favorites.ts).
 *
 * Deliberately dumb next to SavesService: no capture, no extraction — a
 * favorite is just an address and a title. It lives in MAIN anyway so the
 * list persists like the rest of the user's local state: `favorites.json`
 * beside workspace.json, atomic tmp+rename writes, erased by sign-out
 * (LOCAL_STATE_FILES).
 */

import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  MAX_FAVORITES,
  normalizeFavoriteTitle,
  normalizeFavoriteUrl,
  parseFavoritesFile,
  type FavoriteSite,
} from "../shared/favorites";

export const FAVORITES_FILENAME = "favorites.json";

export interface FavoritesServiceDeps {
  userDataDir: string;
  /** The whole list, in tile order — sent on every change. */
  emitUpdated: (favorites: FavoriteSite[]) => void;
  now?: () => number;
  makeId?: () => string;
}

export class FavoritesService {
  private readonly filePath: string;
  private readonly emitUpdated: (favorites: FavoriteSite[]) => void;
  private readonly now: () => number;
  private readonly makeId: () => string;
  /** Tile order: oldest first, so a new favorite joins the end of the row. */
  private favorites: FavoriteSite[];

  constructor(deps: FavoritesServiceDeps) {
    this.filePath = path.join(deps.userDataDir, FAVORITES_FILENAME);
    this.emitUpdated = deps.emitUpdated;
    this.now = deps.now ?? Date.now;
    this.makeId = deps.makeId ?? randomUUID;
    mkdirSync(deps.userDataDir, { recursive: true });
    this.favorites = this.read();
  }

  private read(): FavoriteSite[] {
    if (!existsSync(this.filePath)) return [];
    try {
      return parseFavoritesFile(readFileSync(this.filePath, "utf8"));
    } catch {
      return [];
    }
  }

  private commit(): void {
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify({ items: this.favorites }, null, 2));
    renameSync(tmp, this.filePath);
    this.emitUpdated(this.list());
  }

  list(): FavoriteSite[] {
    return this.favorites.map((favorite) => ({ ...favorite }));
  }

  /**
   * Add an address. Re-adding an existing favorite refreshes its title
   * rather than duplicating it — the star and the settings form both funnel
   * here, and neither should ever create a twin. Throws on an address a tab
   * could not load, so the caller can say why nothing was added.
   */
  add(rawUrl: string, rawTitle: string): FavoriteSite[] {
    const url = normalizeFavoriteUrl(rawUrl);
    if (url === null) {
      throw new Error("A favorite has to be a web address, like example.com");
    }
    const title = normalizeFavoriteTitle(rawTitle, url);
    const existing = this.favorites.find((favorite) => favorite.url === url);
    if (existing !== undefined) {
      existing.title = title;
    } else {
      if (this.favorites.length >= MAX_FAVORITES) {
        throw new Error(`Favorites are limited to ${MAX_FAVORITES} sites`);
      }
      this.favorites = [
        ...this.favorites,
        { id: this.makeId(), url, title, addedAtMs: this.now() },
      ];
    }
    this.commit();
    return this.list();
  }

  remove(id: string): FavoriteSite[] {
    this.favorites = this.favorites.filter((favorite) => favorite.id !== id);
    this.commit();
    return this.list();
  }
}
