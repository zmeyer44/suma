import { describe, expect, it } from "vitest";
import {
  deriveSpaceKeys,
  fromBase64,
  fromUtf8,
  generateDeviceKeypair,
  open,
  type Hlc,
  type SpaceKeys,
  type WorkspaceRecordWire,
} from "@suma/protocol";
import {
  WORKSPACE_PSEUDO_SPACE_ID,
  workspaceSealAad,
} from "../src/main/sync/workspace-map";
import type { WorkspaceRegister } from "../src/main/sync/workspace-map";
import { WorkspaceSyncService } from "../src/main/sync/workspace-sync";
import type { WorkspaceStore } from "../src/main/workspace-store";

/**
 * §8.2 recovery path: on a fresh device the workspace seal/open key is derived
 * at start() from a random stand-in secret. After auth:recoverKeys installs the
 * true account secret, rekey() must swap the live key so every subsequent seal
 * (and the republish of local registers) uses the recovered key — otherwise
 * workspace metadata never converges until an app restart.
 */

function fakeStore(
  registers: Record<string, WorkspaceRegister>,
): WorkspaceStore {
  return {
    manualSyncInitialized() {
      return true;
    },
    markManualSyncInitialized() {},
    onDocsChanged() {
      /* not used by these tests */
      return () => undefined;
    },
    lwwRegisters() {
      return registers;
    },
  } as unknown as WorkspaceStore;
}

async function keysFrom(fill: number): Promise<SpaceKeys> {
  return deriveSpaceKeys(
    WORKSPACE_PSEUDO_SPACE_ID,
    new Uint8Array(32).fill(fill),
  );
}

async function openWith(
  keys: SpaceKeys,
  wire: WorkspaceRecordWire,
): Promise<unknown> {
  if (wire.sealedValue === null) throw new Error("no sealed value");
  return JSON.parse(
    fromUtf8(
      await open(
        keys.sealKey,
        fromBase64(wire.sealedValue),
        workspaceSealAad(wire.key),
      ),
    ),
  );
}

describe("WorkspaceSyncService.rekey (§8.2 recovery)", () => {
  it("seals subsequent publishes under the recovered key, not the stale one", async () => {
    const stale = await keysFrom(1);
    const recovered = await keysFrom(2);
    const kp = await generateDeviceKeypair();
    const registers: Record<string, WorkspaceRegister> = {};
    let changed: ((keys: string[]) => void) | null = null;
    const published = new Promise<WorkspaceRecordWire[]>((resolve) => {
      const svc = new WorkspaceSyncService({
        deviceId: "device-1",
        privateKey: kp.privateKey,
        keys: stale,
        store: {
          manualSyncInitialized() {
            return true;
          },
          markManualSyncInitialized() {},
          onDocsChanged(listener: (keys: string[]) => void) {
            changed = listener;
            return () => {
              changed = null;
            };
          },
          lwwRegisters() {
            return registers;
          },
        } as unknown as WorkspaceStore,
        publish: resolve,
        onRemoteApplied: () => undefined,
      });
      svc.start();
      svc.rekey(recovered);
      registers["settings:keyMode"] = {
        doc: { kind: "settings", field: "keyMode", keyMode: "e2ee" },
        hlc: { physicalMs: 1, logical: 0, deviceId: "device-1" },
      };
      changed?.(["settings:keyMode"]);
    });

    const wire = (await published).at(-1);
    expect(wire).toBeDefined();
    // Opens under the recovered account key...
    expect(await openWith(recovered, wire as WorkspaceRecordWire)).toEqual({
      kind: "settings",
      field: "keyMode",
      keyMode: "e2ee",
    });
    // ...and is unreadable under the pre-recovery stand-in key.
    await expect(
      openWith(stale, wire as WorkspaceRecordWire),
    ).rejects.toThrow();
  });

  it("republishes existing local registers re-sealed under the recovered key", async () => {
    const stale = await keysFrom(1);
    const recovered = await keysFrom(2);
    const kp = await generateDeviceKeypair();
    const hlc: Hlc = { physicalMs: 1000, logical: 0, deviceId: "device-1" };
    const registers: Record<string, WorkspaceRegister> = {
      "settings:historySync": {
        doc: {
          kind: "settings",
          field: "historySync",
          historySyncEnabled: true,
        },
        hlc,
      },
    };

    const republished = new Promise<WorkspaceRecordWire[]>((resolve) => {
      const svc = new WorkspaceSyncService({
        deviceId: "device-1",
        privateKey: kp.privateKey,
        keys: stale,
        store: fakeStore(registers),
        publish: (docs) => resolve(docs),
        onRemoteApplied: () => undefined,
      });
      svc.rekey(recovered);
    });

    const docs = await republished;
    const wire = docs.find((d) => d.key === "settings:historySync");
    expect(wire).toBeDefined();
    expect(await openWith(recovered, wire as WorkspaceRecordWire)).toEqual({
      kind: "settings",
      field: "historySync",
      historySyncEnabled: true,
    });
  });
});
