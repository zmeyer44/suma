/**
 * Friendly device registry + canonical workspace focus materialization.
 *
 * SessionHub presence is intentionally tiny (id/online/last-seen). This
 * service joins it with control-plane enrollment metadata and an encrypted
 * workspace identity record. Active focus is a separate account-global LWW
 * register so all connected devices converge on the same layout.
 */

import type { DevicePresence, SyncedDeviceActivity } from "@suma/protocol";
import type { ConnectedDeviceInfo } from "../shared/ipc";
import type { ControlDevice } from "./control-client";
import type { DeviceStore } from "./device";
import { friendlyPlatform } from "./device-name";
import type { SpaceManager } from "./spaces";
import type { TabManager } from "./tabs";
import type { WorkspaceStore } from "./workspace-store";

function dateMs(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

export function mergeConnectedDevices(args: {
  registry: readonly ControlDevice[];
  presence: readonly DevicePresence[];
  activities: readonly SyncedDeviceActivity[];
  localDeviceId: string;
  localControlDeviceId: string | null;
  localName: string;
  localPlatform: string;
  controlAvailable: boolean;
}): ConnectedDeviceInfo[] {
  const rawPresence = new Map(
    args.presence.map((device) => [device.deviceId, device]),
  );
  const aliasToPrimary = new Map<string, string>();
  for (const activity of args.activities) {
    // Older activity documents may predate these alias fields, so retain the
    // runtime fallbacks even though current TypeScript writers always set them.
    const identityDeviceId = activity.identityDeviceId ?? activity.deviceId;
    const controlDeviceId = activity.controlDeviceId ?? null;
    const primary =
      controlDeviceId !== null && rawPresence.has(controlDeviceId)
        ? controlDeviceId
        : rawPresence.has(identityDeviceId)
          ? identityDeviceId
          : activity.deviceId;
    aliasToPrimary.set(activity.deviceId, primary);
    aliasToPrimary.set(identityDeviceId, primary);
    if (controlDeviceId !== null) aliasToPrimary.set(controlDeviceId, primary);
  }
  const primaryFor = (id: string): string => aliasToPrimary.get(id) ?? id;
  const registry = new Map(
    args.registry.map((device) => [primaryFor(device.id), device]),
  );
  const presence = new Map(
    args.presence.map((device) => {
      const deviceId = primaryFor(device.deviceId);
      return [deviceId, { ...device, deviceId }] as const;
    }),
  );
  const activities = new Map<string, SyncedDeviceActivity>();
  for (const activity of args.activities) {
    const deviceId = primaryFor(activity.deviceId);
    const current = activities.get(deviceId);
    if (current === undefined || current.updatedAtMs < activity.updatedAtMs) {
      activities.set(deviceId, { ...activity, deviceId });
    }
  }
  const selfIds = new Set(
    [args.localDeviceId, args.localControlDeviceId]
      .filter((id): id is string => id !== null)
      .map(primaryFor),
  );
  const ids = new Set([
    ...registry.keys(),
    ...presence.keys(),
    ...activities.keys(),
  ]);
  ids.add(primaryFor(args.localControlDeviceId ?? args.localDeviceId));

  const devices: ConnectedDeviceInfo[] = [];
  for (const id of ids) {
    const registered = registry.get(id);
    const live = presence.get(id);
    const activity = activities.get(id);
    const isThisDevice = selfIds.has(id);
    const revoked =
      registered?.revoked === true || registered?.revokedAt != null;
    const registryLastSeen = dateMs(registered?.lastSeenAt);
    const lastSeenMs = Math.max(
      live?.lastSeenMs ?? 0,
      registryLastSeen ?? 0,
      activity?.updatedAtMs ?? 0,
    );
    devices.push({
      deviceId: id,
      name:
        registered?.name ??
        activity?.name ??
        (isThisDevice ? args.localName : `Mac ${shortId(id)}`),
      platform: friendlyPlatform(
        registered?.platform ??
          activity?.platform ??
          (isThisDevice ? args.localPlatform : ""),
      ),
      online: !revoked && live?.online === true,
      lastSeenMs,
      enrolledAtMs: dateMs(registered?.enrolledAt),
      revoked,
      isThisDevice,
      canRename:
        !revoked &&
        (registered !== undefined || (isThisDevice && args.controlAvailable)),
    });
  }

  return devices.sort((a, b) => {
    if (a.revoked !== b.revoked) return a.revoked ? 1 : -1;
    if (a.isThisDevice !== b.isThisDevice) return a.isThisDevice ? -1 : 1;
    if (a.online !== b.online) return a.online ? -1 : 1;
    return a.name.localeCompare(b.name) || a.deviceId.localeCompare(b.deviceId);
  });
}

export interface DeviceCollaborationDeps {
  device: DeviceStore;
  store: WorkspaceStore;
  spaces: SpaceManager;
  tabs: TabManager;
  suggestedName: string;
  presence: () => DevicePresence[];
  listRegistry: () => Promise<ControlDevice[]>;
  renameRegisteredDevice: (deviceId: string, name: string) => Promise<void>;
  controlAvailable: () => boolean;
}

export class DeviceCollaborationService {
  private registryCache: ControlDevice[] = [];
  private registryLoadedAtMs = 0;

  constructor(private readonly deps: DeviceCollaborationDeps) {}

  private localDeviceId(): string {
    const enrollment = this.deps.device.enrollment();
    const onlineIds = new Set(
      this.deps.presence().map((device) => device.deviceId),
    );
    if (
      enrollment.controlDeviceId !== null &&
      onlineIds.has(enrollment.controlDeviceId)
    ) {
      return enrollment.controlDeviceId;
    }
    if (onlineIds.has(this.deps.device.deviceId))
      return this.deps.device.deviceId;
    return enrollment.controlDeviceId ?? this.deps.device.deviceId;
  }

  private localName(): string {
    return this.deps.device.enrollment().deviceName ?? this.deps.suggestedName;
  }

  private localActivity(): SyncedDeviceActivity {
    return {
      deviceId: this.localDeviceId(),
      identityDeviceId: this.deps.device.deviceId,
      controlDeviceId: this.deps.device.enrollment().controlDeviceId,
      name: this.localName(),
      platform: process.platform,
      updatedAtMs: Date.now(),
    };
  }

  /** Publish this Mac's encrypted human-readable identity. */
  capture(): void {
    const activity = this.localActivity();
    this.deps.store.updateSyncedDeviceActivity(activity);
  }

  /** Apply the account-global focus winner without publishing it again. */
  applySharedFocus(): void {
    const focus = this.deps.store.syncedWorkspaceFocus();
    if (focus?.activeSpaceId === null || focus?.activeSpaceId === undefined)
      return;
    if (this.deps.spaces.get(focus.activeSpaceId) === undefined) return;
    this.deps.store.setActiveSpaceId(focus.activeSpaceId);
    this.deps.tabs.applySyncedFocus(
      focus.activeSpaceId,
      focus.activeTabId,
      focus.splitTabId,
    );
  }

  invalidateRegistry(): void {
    this.registryLoadedAtMs = 0;
  }

  async list(forceRegistryRefresh = false): Promise<ConnectedDeviceInfo[]> {
    if (forceRegistryRefresh || Date.now() - this.registryLoadedAtMs > 30_000) {
      try {
        this.registryCache = await this.deps.listRegistry();
        this.registryLoadedAtMs = Date.now();
      } catch {
        // Offline still has encrypted activity labels + live hub presence.
      }
    }
    const enrollment = this.deps.device.enrollment();
    return mergeConnectedDevices({
      registry: this.registryCache,
      presence: this.deps.presence(),
      activities: this.deps.store.syncedDeviceActivities(),
      localDeviceId: this.deps.device.deviceId,
      localControlDeviceId: enrollment.controlDeviceId,
      localName: this.localName(),
      localPlatform: process.platform,
      controlAvailable: this.deps.controlAvailable(),
    });
  }

  async rename(deviceId: string, name: string): Promise<void> {
    await this.deps.renameRegisteredDevice(deviceId, name.trim());
    this.invalidateRegistry();
    this.capture();
  }

}
