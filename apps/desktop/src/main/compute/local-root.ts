/**
 * Where the simulated machine's shared filesystem roots on this Mac.
 *
 * Local compute mode dedicates this Mac as the account's computer, and the
 * product folder for that is ~/Suma — a deliberate mirror of the VM's
 * ~/cloud: one folder per space inside it, downloads under the space's
 * Downloads/. Never the bare home directory: remote devices (and a
 * compromised renderer) reach whatever this root reaches.
 *
 * The root is ~/Suma everywhere — dev and packaged, cloud and local — so the
 * embedded terminal and the file explorer always open on the same coherent
 * "virtual computer" folder rather than, in a dev run, the repo you launched
 * from. A developer who wants a different root (the project being worked on,
 * a throwaway dir) sets SUMA_WORKSPACE_ROOT, which always wins.
 */

import os from "node:os";
import path from "node:path";
import process from "node:process";

export type ComputeMode = "cloud" | "local";

export function resolveSimRoot(): string {
  const override = process.env["SUMA_WORKSPACE_ROOT"];
  if (override !== undefined && override.length > 0) return path.resolve(override);
  return path.join(os.homedir(), "Suma");
}
