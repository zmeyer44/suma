/**
 * Server-side human summaries for the audit trail UI (PRD §8.7). The UI
 * renders these strings verbatim, so every branch must read as a plain
 * sentence. Covers every audit type the control plane emits (grep `audit(`
 * in src/app.ts) plus a default so an unknown type still renders.
 */

export type AuditPayload = Record<string, unknown> | null;

/** Every audit type the control plane currently emits. */
export const KNOWN_AUDIT_TYPES = [
  "account.created",
  "auth.device_credential_registered",
  "auth.passkey_registered",
  "device.enrolled",
  "device.revoked",
  "space.updated",
  "keys.wrapper_added",
  "keys.wrapper_rotated",
  "keys.wrapper_removed",
  "keys.recovery_set",
  "machine.transition",
  "machine.boosted",
  "job.mode_changed",
  "capability.minted",
  "abuse.limit_hit",
  "files.uploaded",
  "files.deleted",
  "files.quota_blocked",
  "transfer.created",
  "transfer.cancelled",
] as const;

function str(payload: AuditPayload, key: string): string | undefined {
  const value = payload?.[key];
  return typeof value === "string" ? value : undefined;
}

function num(payload: AuditPayload, key: string): number | undefined {
  const value = payload?.[key];
  return typeof value === "number" ? value : undefined;
}

function bool(payload: AuditPayload, key: string): boolean | undefined {
  const value = payload?.[key];
  return typeof value === "boolean" ? value : undefined;
}

export function summarize(type: string, payload: AuditPayload): string {
  switch (type) {
    case "account.created": {
      const email = str(payload, "email");
      return email ? `Account created for ${email}.` : "Account created.";
    }
    case "auth.device_credential_registered":
      return "A device registered its identity key as a login credential.";
    case "auth.passkey_registered":
      return bool(payload, "prfCapable")
        ? "A passkey was registered (PRF-capable)."
        : "A passkey was registered.";
    case "device.enrolled": {
      const name = str(payload, "name");
      return name ? `Device "${name}" was enrolled.` : "A device was enrolled.";
    }
    case "device.revoked": {
      const reason = str(payload, "reason");
      return reason ? `A device was revoked (reason: ${reason}).` : "A device was revoked.";
    }
    case "space.updated": {
      const egress = payload?.["egressPolicy"];
      if (typeof egress === "object" && egress !== null) {
        const change = egress as Record<string, unknown>;
        if (typeof change["from"] === "string" && typeof change["to"] === "string") {
          return `A space's egress policy changed from ${change["from"]} to ${change["to"]}.`;
        }
      }
      return "A space was updated.";
    }
    case "keys.wrapper_added": {
      const kind = str(payload, "kind");
      return kind ? `A wrapped key was stored (${kind}).` : "A wrapped key was stored.";
    }
    case "keys.wrapper_rotated": {
      const kind = str(payload, "kind");
      return kind ? `A wrapped key was rotated (${kind}).` : "A wrapped key was rotated.";
    }
    case "keys.wrapper_removed": {
      const kind = str(payload, "kind");
      return kind ? `A wrapped key was removed (${kind}).` : "A wrapped key was removed.";
    }
    case "keys.recovery_set":
      return "A recovery code was set for a space.";
    case "machine.transition": {
      const from = str(payload, "from");
      const to = str(payload, "to");
      const reconstructed = bool(payload, "reconstructed");
      if (from && to) {
        const move = `Your machine moved from ${from} to ${to}`;
        return reconstructed ? `${move} (restored from cold start).` : `${move}.`;
      }
      return "Your machine changed state.";
    }
    case "machine.boosted": {
      const memoryMb = num(payload, "memoryMb");
      return memoryMb
        ? `Your machine was boosted to ${memoryMb / 1024} GB of memory.`
        : "Your machine was boosted.";
    }
    case "job.mode_changed": {
      const ptyId = str(payload, "ptyId");
      const enabled = bool(payload, "enabled");
      const where = ptyId ? ` for terminal ${ptyId}` : "";
      return enabled
        ? `Job Mode was turned on${where} — the machine will stay awake.`
        : `Job Mode was turned off${where}.`;
    }
    case "capability.minted": {
      const caps = payload?.["caps"];
      if (Array.isArray(caps) && caps.every((c) => typeof c === "string")) {
        return `An agent capability token was issued (${caps.join(", ")}).`;
      }
      return "An agent capability token was issued.";
    }
    case "abuse.limit_hit": {
      const reason = str(payload, "reason");
      return reason ? `A usage limit was hit: ${reason}` : "A usage limit was hit.";
    }
    case "files.uploaded": {
      const path = str(payload, "path");
      return path ? `File "${path}" finished uploading.` : "A file finished uploading.";
    }
    case "files.deleted": {
      const path = str(payload, "path");
      return path ? `File "${path}" was deleted.` : "A file was deleted.";
    }
    case "files.quota_blocked":
      return (
        "An upload was refused because it would exceed your Files quota. " +
        "Existing files stay available."
      );
    // The audit trail records the ORIGIN HOST, never the URL: a presigned link
    // is bearer authority, and a log that stored one would hand it to anyone
    // who can read the trail (§8.6).
    case "transfer.created": {
      const host = str(payload, "host");
      const destPath = str(payload, "destPath");
      const where = destPath ? ` to "${destPath}"` : "";
      return host
        ? `A cloud download from ${host} started${where}.`
        : `A cloud download started${where}.`;
    }
    case "transfer.cancelled": {
      const destPath = str(payload, "destPath");
      return destPath
        ? `The cloud download to "${destPath}" was cancelled.`
        : "A cloud download was cancelled.";
    }
    default:
      return `Unrecognized event (${type}).`;
  }
}
