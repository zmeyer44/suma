/**
 * SpaceManager — space CRUD backed by the workspace store, plus one Electron
 * session per space (`persist:space-<id>`): the per-space cookie jar that is
 * the Spaces trust boundary (PRD §8.8).
 */

import { randomUUID } from "node:crypto";
import { dialog, session, type Session, type WebContents } from "electron";
import type { SpaceMeta } from "@suma/protocol";
import { classifyPermission, permissionPromptText } from "./permission-policy";
import type { WorkspaceStore } from "./workspace-store";

export type TabMembershipResolver = (webContentsId: number, spaceId: string) => boolean;

export type SpaceMetaPatch = Partial<Pick<SpaceMeta, "name" | "color" | "position" | "egressPolicy">>;

const DEFAULT_SPACE_NAME = "Personal";
const DEFAULT_SPACE_COLOR = "#5b8cff";

export class SpaceManager {
  private readonly sessions = new Map<string, Session>();
  private readonly listeners: Array<() => void> = [];
  private readonly sessionListeners: Array<(ses: Session, spaceId: string) => void> = [];
  private tabMembership: TabMembershipResolver = () => false;
  private popupMembership: TabMembershipResolver = () => false;

  /** The space this launch auto-created because the store was empty. On a
   *  device that then links to an existing account, that throwaway default
   *  must not linger as a synced duplicate (§8.8) — reconcileAfterSync drops
   *  it once the account's real spaces arrive. Null once handled or never set. */
  private autoCreatedDefaultId: string | null = null;

  constructor(private readonly store: WorkspaceStore) {
    if (this.store.spaces().length === 0) {
      this.autoCreatedDefaultId = this.create(DEFAULT_SPACE_NAME, DEFAULT_SPACE_COLOR).id;
    }
    const spaces = this.list();
    const active = this.store.activeSpaceId();
    if (active === null || !spaces.some((space) => space.id === active)) {
      const first = spaces[0];
      if (first !== undefined) this.store.setActiveSpaceId(first.id);
    }
  }

  /**
   * Called after the workspace stream applies remote docs. If this device
   * auto-created a default space and the account has since synced in its OWN
   * spaces, the throwaway default (never pinned to, so never used) is removed
   * so devices don't accumulate empty "Personal" duplicates — the exact
   * fragmentation that split synced cookies from the space being browsed.
   * Active space is moved to a real (pinned) space so the user lands where
   * their carried-over sessions actually live.
   */
  reconcileAfterSync(): void {
    const auto = this.autoCreatedDefaultId;
    if (auto === null) return;
    const others = this.list().filter((space) => space.id !== auto);
    if (others.length === 0) return; // brand-new account — keep the default
    if (this.store.pinsFor(auto).length > 0) {
      this.autoCreatedDefaultId = null; // it got used; it's a real space now
      return;
    }
    this.remove(auto);
    this.autoCreatedDefaultId = null;
    const active = this.store.activeSpaceId();
    if (active === null || active === auto || this.get(active) === undefined) {
      const target = others.find((s) => this.store.pinsFor(s.id).length > 0) ?? others[0];
      if (target !== undefined) this.store.setActiveSpaceId(target.id);
    }
  }

  /** Remove a space (tombstoned, propagates to all devices). Refuses to
   *  delete the last space, and re-homes the active pointer if needed. */
  remove(spaceId: string): void {
    if (this.get(spaceId) === undefined) return;
    if (this.list().length <= 1) throw new Error("cannot remove the last space");
    this.store.removeSpace(spaceId);
    if (this.store.activeSpaceId() === spaceId) {
      const next = this.list()[0];
      if (next !== undefined) {
        this.store.setActiveSpaceId(next.id);
        this.store.publishCurrentWorkspaceFocus();
      }
    }
    this.notify();
  }

  onChanged(listener: () => void): void {
    this.listeners.push(listener);
  }

  /** Wired after TabManager exists — permission requests must come from a tab in the space. */
  setTabMembershipResolver(resolver: TabMembershipResolver): void {
    this.tabMembership = resolver;
  }

  /** Auth popups share the space session; they are attributable too. */
  setPopupMembershipResolver(resolver: TabMembershipResolver): void {
    this.popupMembership = resolver;
  }

  /**
   * Called once per space session as it is created — session-scoped features
   * (passkey account picker, downloads) attach here. Registering after some
   * sessions already exist replays them, so ordering at bootstrap is not a
   * silent correctness trap.
   */
  onSessionCreated(listener: (ses: Session, spaceId: string) => void): void {
    this.sessionListeners.push(listener);
    for (const [spaceId, ses] of this.sessions) listener(ses, spaceId);
  }

  list(): SpaceMeta[] {
    return this.store.spaces().sort((a, b) => a.position - b.position);
  }

  get(spaceId: string): SpaceMeta | undefined {
    return this.store.spaces().find((space) => space.id === spaceId);
  }

  get activeSpaceId(): string | null {
    return this.store.activeSpaceId();
  }

  create(name: string, color: string): SpaceMeta {
    const positions = this.store.spaces().map((space) => space.position);
    const meta: SpaceMeta = {
      id: randomUUID(),
      name,
      color,
      position: positions.length === 0 ? 0 : Math.max(...positions) + 1,
      // Egress plane is Phase 2 (§8.4): every space browses direct in v0.
      egressPolicy: "direct",
      createdAtMs: Date.now(),
    };
    this.store.upsertSpace(meta);
    this.notify();
    return meta;
  }

  update(spaceId: string, patch: SpaceMetaPatch): SpaceMeta {
    const current = this.get(spaceId);
    if (current === undefined) throw new Error(`unknown space ${spaceId}`);
    const next: SpaceMeta = { ...current, ...patch };
    this.store.upsertSpace(next);
    this.notify();
    return next;
  }

  setActive(spaceId: string): void {
    if (this.get(spaceId) === undefined) throw new Error(`unknown space ${spaceId}`);
    this.store.setActiveSpaceId(spaceId);
    this.store.publishCurrentWorkspaceFocus();
    this.notify();
  }

  sessionFor(spaceId: string): Session {
    const existing = this.sessions.get(spaceId);
    if (existing !== undefined) return existing;
    const ses = session.fromPartition(`persist:space-${spaceId}`);
    this.configureSession(ses, spaceId);
    // Register before notifying: a listener that calls back into sessionFor
    // for this same space must find the session, not recurse.
    this.sessions.set(spaceId, ses);
    for (const listener of this.sessionListeners) listener(ses, spaceId);
    return ses;
  }

  private configureSession(ses: Session, spaceId: string): void {
    // TODO(§8.4): when the identity egress plane lands, proxied spaces must
    // disable QUIC here — a CONNECT proxy tunnels TCP only, and Chromium
    // would otherwise race QUIC over UDP straight past the proxy, leaking
    // the real IP. Egress plane is Phase 2; v0 spaces browse direct.
    ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
      this.resolvePermission(spaceId, webContents, permission, details.requestingUrl)
        .then(callback)
        .catch(() => callback(false));
    });
  }

  /**
   * Auth-critical permissions (Storage Access API, sanitized clipboard write)
   * are granted to attributable tab requests; camera/mic/screen prompt once
   * per origin and the decision is remembered; everything else fails closed
   * (§8.1 permission-UI baseline). See permission-policy.ts for the why.
   */
  private async resolvePermission(
    spaceId: string,
    webContents: WebContents | null,
    permission: string,
    requestingUrl: string,
  ): Promise<boolean> {
    // A popup opened by a tab shares the space session but is not itself a
    // tab; auth ceremonies run there, so accept either.
    const attributable =
      webContents !== null &&
      (this.tabMembership(webContents.id, spaceId) ||
        this.popupMembership(webContents.id, spaceId));
    const outcome = classifyPermission(permission, attributable);
    if (outcome === "deny") return false;
    if (outcome === "grant") return true;

    let origin: string;
    try {
      origin = new URL(requestingUrl).origin;
    } catch {
      return false;
    }
    const remembered = this.store.permissionDecision(origin, permission);
    if (remembered !== null) return remembered;
    const { response } = await dialog.showMessageBox({
      type: "question",
      message: `Allow ${origin} to ${permissionPromptText(permission)}?`,
      detail: `Requested by a tab in the "${this.get(spaceId)?.name ?? spaceId}" space.`,
      buttons: ["Allow", "Don't Allow"],
      defaultId: 1,
      cancelId: 1,
    });
    const granted = response === 0;
    this.store.setPermissionDecision(origin, permission, granted);
    return granted;
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
