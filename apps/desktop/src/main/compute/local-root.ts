/**
 * Where the simulated machine's shared filesystem roots on this Mac.
 *
 * Local compute mode dedicates this Mac as the account's computer, and the
 * product folder for that is ~/Suma — a deliberate mirror of the VM's
 * ~/cloud: one folder per space inside it, downloads under the space's
 * Downloads/. Never the bare home directory: remote devices (and a
 * compromised renderer) reach whatever this root reaches.
 *
 * Precedence:
 *   1. SUMA_WORKSPACE_ROOT — the dev escape hatch, always wins.
 *   2. Local mode          — ~/Suma.
 *   3. Dev run             — the project being worked on (cwd), which is
 *                            what a developer expects the IDE to show.
 *   4. Packaged, no mode   — ~/Suma still: pre-onboarding there is nothing
 *                            to show, and homedir would overshare.
 */

import os from "node:os";
import path from "node:path";
import process from "node:process";

export type ComputeMode = "cloud" | "local";

export function resolveSimRoot(isPackaged: boolean, mode?: ComputeMode | null): string {
  const override = process.env["SUMA_WORKSPACE_ROOT"];
  if (override !== undefined && override.length > 0) return path.resolve(override);
  if (mode === "local") return path.join(os.homedir(), "Suma");
  if (!isPackaged) return process.cwd();
  return path.join(os.homedir(), "Suma");
}
