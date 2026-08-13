import { describe, expect, it } from "vitest";
import {
  deriveSpaceKeys,
  generateDeviceKeypair,
  SPACE_ROOT_SECRET_BYTES,
  type CookieAttributes,
  type CookieIdentity,
  type CookieRecordWire,
  type Cause,
  type CookiePlain,
  type DeviceKeypair,
  type SpaceKeys,
} from "@suma/protocol";
import {
  SpaceSyncEngine,
  type CookieApplier,
  type SyncTransport,
} from "@suma/sync-engine";
import { partitionLiveRecords } from "../src/main/sync/live-partition";

/**
 * Regression for the Mac-A-goes-stale incident (§8.3): Mac A signed into
 * Gmail, linked Mac B, and B's use of the session rotated Google's cookies.
 * The rotated records reached A but were staged behind the explicit Sync
 * control, so A kept presenting the retired generation and Google signed it
 * out. Live records for rotating-auth origins must be applied on arrival;
 * everything else keeps the stage-for-explicit-Sync behavior.
 */

class RecordingApplier implements CookieApplier {
  readonly applied: Array<{ plain: CookiePlain; cause: Cause }> = [];

  apply(plain: CookiePlain, cause: Cause): Promise<void> {
    this.applied.push({ plain, cause });
    return Promise.resolve();
  }
}

const grantingTransport: SyncTransport = {
  publish: () => undefined,
  acquireLease: () => Promise.resolve(true),
  releaseLease: () => undefined,
};

function identityFor(
  spaceId: string,
  hostKey: string,
  name: string,
): CookieIdentity {
  return {
    spaceId,
    hostKey,
    name,
    path: "/",
    partitionKey: "",
    sourceScheme: "secure",
  };
}

function attrsFor(value: string): CookieAttributes {
  return {
    value,
    expiresMs: null,
    persistent: false,
    secure: true,
    httpOnly: true,
    sameSite: "lax",
    priority: "medium",
  };
}

interface Device {
  engine: SpaceSyncEngine;
  applier: RecordingApplier;
}

async function createDevice(
  spaceId: string,
  deviceId: string,
  keys: SpaceKeys,
  keypair: DeviceKeypair,
): Promise<Device> {
  const applier = new RecordingApplier();
  const engine = new SpaceSyncEngine(
    spaceId,
    keys,
    { deviceId, privateKey: keypair.privateKey },
    grantingTransport,
    applier,
    { deviceId },
  );
  return { engine, applier };
}

async function linkedPair(spaceId: string): Promise<{ a: Device; b: Device }> {
  const keys = await deriveSpaceKeys(
    spaceId,
    new Uint8Array(SPACE_ROOT_SECRET_BYTES).fill(7),
  );
  const keypair = await generateDeviceKeypair();
  return {
    a: await createDevice(spaceId, "mac-a", keys, keypair),
    b: await createDevice(spaceId, "mac-b", keys, keypair),
  };
}

function mustWire(wire: CookieRecordWire | null): CookieRecordWire {
  if (wire === null) throw new Error("expected a published record");
  return wire;
}

describe("rotating-auth live apply (§8.3)", () => {
  it("partitions rotating-auth records to auto-apply and stages the rest", async () => {
    const spaceId = "space-live-partition";
    const { a, b } = await linkedPair(spaceId);

    const rotated = mustWire(
      await b.engine.localChange(
        identityFor(spaceId, "gmail.com", "__Secure-1PSIDTS"),
        attrsFor("rotated-on-mac-b"),
        false,
        "overwrite",
      ),
    );
    const portable = mustWire(
      await b.engine.localChange(
        identityFor(spaceId, "github.com", "user_session"),
        attrsFor("gh-session"),
        false,
        "explicit",
      ),
    );

    const partition = await partitionLiveRecords(a.engine, [
      rotated,
      portable,
    ]);
    expect(partition.autoApply.map((r) => r.recordId)).toEqual([
      rotated.recordId,
    ]);
    expect(partition.stage.map((r) => r.recordId)).toEqual([
      portable.recordId,
    ]);
  });

  it("Mac A's jar picks up Mac B's rotation without a manual pull", async () => {
    const spaceId = "space-live-rotation";
    const { a, b } = await linkedPair(spaceId);

    const rotated = mustWire(
      await b.engine.localChange(
        identityFor(spaceId, "gmail.com", "__Secure-1PSIDTS"),
        attrsFor("fresh-generation"),
        false,
        "overwrite",
      ),
    );

    const { autoApply } = await partitionLiveRecords(a.engine, [rotated]);
    expect(await a.engine.applyRemote(autoApply)).toEqual(["applied"]);
    expect(a.applier.applied.at(-1)?.plain.attributes?.value).toBe(
      "fresh-generation",
    );
  });

  it("a user 'never sync' override keeps a rotating-auth origin staged", async () => {
    const spaceId = "space-live-never";
    const { a, b } = await linkedPair(spaceId);
    a.engine.setOriginOverride("gmail.com", "never");

    const rotated = mustWire(
      await b.engine.localChange(
        identityFor(spaceId, "gmail.com", "__Secure-1PSIDTS"),
        attrsFor("rotated"),
        false,
        "overwrite",
      ),
    );

    const partition = await partitionLiveRecords(a.engine, [rotated]);
    expect(partition.autoApply).toHaveLength(0);
    expect(partition.stage.map((r) => r.recordId)).toEqual([rotated.recordId]);
  });

  it("stages a record it cannot open rather than applying it blind", async () => {
    const spaceId = "space-live-miskeyed";
    const { b } = await linkedPair(spaceId);
    const foreignKeys = await deriveSpaceKeys(
      spaceId,
      new Uint8Array(SPACE_ROOT_SECRET_BYTES).fill(9),
    );
    const keypair = await generateDeviceKeypair();
    const misKeyed = await createDevice(
      spaceId,
      "mac-miskeyed",
      foreignKeys,
      keypair,
    );

    const rotated = mustWire(
      await b.engine.localChange(
        identityFor(spaceId, "gmail.com", "__Secure-1PSIDTS"),
        attrsFor("sealed-elsewhere"),
        false,
        "overwrite",
      ),
    );

    const partition = await partitionLiveRecords(misKeyed.engine, [rotated]);
    expect(partition.autoApply).toHaveLength(0);
    expect(partition.stage.map((r) => r.recordId)).toEqual([rotated.recordId]);
  });
});
