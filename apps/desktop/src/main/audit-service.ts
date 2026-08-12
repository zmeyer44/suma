/**
 * AuditService — the audit:list IPC surface (PRD §8.7): a thin proxy over the
 * control plane's audit API. Local-only mode returns an empty list — the
 * audit trail lives on the control plane, and there is nothing honest to
 * show without one.
 */

import type { AuditEntry } from "../shared/ipc";
import type { ControlAuditEvent, ControlClient } from "./control-client";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * Client-side fallback summaries for control planes that predate the
 * server-side `summary` field. The server's wording wins whenever present.
 */
export function summarizeAudit(type: string, payload: Record<string, unknown> | null): string {
  const str = (key: string): string | undefined => {
    const value = payload?.[key];
    return typeof value === "string" ? value : undefined;
  };
  switch (type) {
    case "account.created":
      return "Account created.";
    case "auth.device_credential_registered":
      return "A device key was registered as a login credential.";
    case "auth.passkey_registered":
      return "A passkey was registered.";
    case "device.enrolled": {
      const name = str("name");
      return name === undefined ? "A device was enrolled." : `Device "${name}" was enrolled.`;
    }
    case "device.revoked":
      return "A device was revoked.";
    case "space.updated":
      return "Space settings were updated.";
    case "keys.wrapper_added":
      return "Key material was wrapped for a new credential.";
    case "keys.wrapper_rotated":
      return "Wrapped key material was rotated.";
    case "keys.wrapper_removed":
      return "Wrapped key material was removed.";
    case "keys.recovery_set":
      return "A recovery code was set.";
    case "machine.transition": {
      const from = str("from");
      const to = str("to");
      const move = from !== undefined && to !== undefined ? ` (${from} → ${to})` : "";
      return payload?.["reconstructed"] === true
        ? `Machine cold-booted${move} — context restored, processes lost.`
        : `Machine state changed${move}.`;
    }
    case "machine.boosted":
      return "Machine was boosted.";
    case "job.mode_changed":
      return payload?.["enabled"] === true
        ? "Job Mode enabled — machine pinned awake."
        : "Job Mode disabled.";
    case "capability.minted":
      return "A machine capability token was minted.";
    case "abuse.limit_hit":
      return "A usage limit was hit.";
    default:
      return type;
  }
}

export function presentAuditEvent(row: ControlAuditEvent): AuditEntry {
  const createdAtMs = Date.parse(row.createdAt);
  return {
    id: row.id,
    type: row.type,
    createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : 0,
    actorDeviceId: row.actorDeviceId,
    summary: row.summary ?? summarizeAudit(row.type, row.payload),
  };
}

export class AuditService {
  constructor(private readonly control: () => ControlClient | null) {}

  async list(limit: number = DEFAULT_LIMIT): Promise<AuditEntry[]> {
    const client = this.control();
    if (client === null) return [];
    const clamped = Math.max(1, Math.min(MAX_LIMIT, Math.round(limit)));
    return (await client.listAudit(clamped)).map(presentAuditEvent);
  }
}
