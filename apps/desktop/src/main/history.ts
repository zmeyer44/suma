/**
 * HistoryService — browsing-history capture and lookup (PRD §8.3: history is
 * "user-configurable encrypted sync, off by default").
 *
 * Capture is always-on and LOCAL — a browser without history is broken — and
 * the sync toggle governs only whether visits are published (sealed, via the
 * workspace-doc stream; see WorkspaceStore.addHistoryVisit). Privileged and
 * non-web URLs (suma://, the new-tab page) are never recorded.
 */

import { randomUUID } from "node:crypto";
import type { HistoryVisit } from "@suma/protocol";
import { isAllowedTabUrl, NEW_TAB_URL } from "./tab-policy";

/** A same-URL visit inside this window is a reload/SPA echo, not a new visit. */
export const HISTORY_DEDUPE_MS = 30_000;

/** The store surface HistoryService needs — WorkspaceStore implements it. */
export interface HistoryStore {
  historyVisits(): HistoryVisit[];
  addHistoryVisit(visit: HistoryVisit): void;
  updateHistoryVisitTitle(id: string, title: string): void;
  clearHistory(): void;
}

export class HistoryService {
  /** Latest visit id per URL, so late titles land on the right visit. */
  private readonly latestByUrl = new Map<string, { id: string; atMs: number }>();

  constructor(
    private readonly store: HistoryStore,
    private readonly now: () => number = Date.now,
    private readonly makeId: () => string = randomUUID,
  ) {}

  /** Record a committed navigation. Non-web and new-tab URLs are ignored. */
  noteVisit(url: string, title: string): void {
    if (url === NEW_TAB_URL || url === "" || !isAllowedTabUrl(url)) return;
    const at = this.now();
    const latest = this.latestByUrl.get(url);
    if (latest !== undefined && at - latest.atMs < HISTORY_DEDUPE_MS) {
      latest.atMs = at;
      return;
    }
    const visit: HistoryVisit = { id: this.makeId(), url, title, atMs: at };
    this.latestByUrl.set(url, { id: visit.id, atMs: at });
    this.store.addHistoryVisit(visit);
  }

  /** Pages usually title AFTER the navigation commits — attach it late. */
  noteTitle(url: string, title: string): void {
    if (title === "") return;
    const latest = this.latestByUrl.get(url);
    if (latest === undefined) return;
    this.store.updateHistoryVisitTitle(latest.id, title);
  }

  /** Newest first, filtered by a case-insensitive substring of URL or title. */
  list(query: string, limit: number): HistoryVisit[] {
    const q = query.trim().toLowerCase();
    const visits = this.store.historyVisits();
    const matched =
      q === ""
        ? visits
        : visits.filter(
            (v) => v.url.toLowerCase().includes(q) || v.title.toLowerCase().includes(q),
          );
    return matched.slice(0, Math.max(0, limit));
  }

  clear(): void {
    this.latestByUrl.clear();
    this.store.clearHistory();
  }
}
