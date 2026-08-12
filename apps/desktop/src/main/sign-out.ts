/**
 * Sign out (§8.2) — the inverse of enrollment. Signing out is a LOCAL reset:
 * it drops the account on this Mac and erases everything that was browsed or
 * enrolled under it, then relaunches into a first-run app.
 *
 * Three stores hold that state and all three have to go, or the "fresh app"
 * is a lie:
 *   - device.json      the Ed25519 identity, the auth token, and the space +
 *                      workspace root secrets (§8.2 key hierarchy)
 *   - workspace.json   spaces, pins, archives, history, settings, downloads,
 *                      permission grants, and the LWW registers (§8.3)
 *   - the per-space Chromium sessions — the site cookies themselves, which
 *                      are the whole point of the Spaces trust boundary (§8.8)
 *
 * What it deliberately does NOT do: revoke on the control plane. This Mac's
 * device row stays enrolled on the account until it is revoked from another
 * device (§8.2 revocation is a separate, explicit act with its own receipt) —
 * the UI copy says so rather than implying a sign-out kills the device.
 *
 * And what it deliberately does NOT do either: restart the process. Every
 * service is rebuilt IN PLACE around the same window (see index.ts), because
 * `app.relaunch()` is not available to us in development — electron-vite runs
 * the app as a child of the dev server and exits with it (`ps.on('close',
 * process.exit)`), so quitting to restart takes Vite down and the relaunched
 * Electron comes back to a dead ELECTRON_RENDERER_URL: a blank window and no
 * dev server. An in-process reset is also the path the developer exercises
 * every day, which is the one worth having tested.
 */

import { rmSync } from "node:fs";
import path from "node:path";
import type { Session } from "electron";

/** Everything Suma persists in userData outside the Chromium session stores. */
export const LOCAL_STATE_FILES = [
  "device.json",
  "workspace.json",
  "files-prefs.json",
  // Voice & audio: the TTS provider choice AND its API keys (§8.1). A key is
  // account-adjacent credential material, so it goes with the account.
  "tts.json",
  // Saved items are browsing-derived user data — they leave with the account.
  "saves.json",
  // Saved videos: the library index. The media cache directory beside it is
  // removed in removeLocalState (VIDEOS_DIR below).
  "videos.json",
  // The Nostr signer: the (safeStorage-encrypted) nsec and every per-site
  // signing rule. Credential material, so it goes with the account.
  "nostr.json",
  // Favorite sites are the same kind of user data as saves.
  "favorites.json",
] as const;

/**
 * Chromium's per-space cookie jars. `clearStorageData` empties the stores but
 * leaves the directory — and a jar belonging to a space that no longer exists
 * is residue, not state, so the whole tree goes with it. Everything under
 * Partitions/ is a `persist:space-<id>` jar (the Files page session is
 * ephemeral and never lands on disk), and this runs immediately before the
 * relaunch, so nothing recreates it.
 */
const PARTITIONS_DIR = "Partitions";

/** The saved-videos media cache (main/videos) — downloaded site content, so
 *  it is account data and goes with the account. The directory itself is
 *  recreated empty by the next account's VideosService. */
const VIDEOS_DIR = "videos";

/**
 * Paths to unlink, including the `.tmp` staging files of the atomic writes in
 * DeviceStore/WorkspaceStore — a crash can leave one behind, and a stale
 * device.json.tmp next to a deleted device.json is confusing at best.
 */
export function localStatePaths(userDataDir: string): string[] {
  return LOCAL_STATE_FILES.flatMap((name) => {
    const file = path.join(userDataDir, name);
    return [file, `${file}.tmp`];
  });
}

export function removeLocalState(userDataDir: string): void {
  for (const file of localStatePaths(userDataDir)) rmSync(file, { force: true });
  rmSync(path.join(userDataDir, PARTITIONS_DIR), { force: true, recursive: true });
  rmSync(path.join(userDataDir, VIDEOS_DIR), { force: true, recursive: true });
}

/** Cookies, storage, caches, and cached HTTP credentials, per session. */
async function clearSession(ses: Session): Promise<void> {
  await ses.clearStorageData();
  await ses.clearCache();
  await ses.clearAuthCache();
}

export interface SignOutDeps {
  userDataDir: string;
  /** Stop the long-lived services before their state is deleted under them. */
  stopServices: () => void;
  /** Every session holding account data: the per-space cookie jars, the Files
   *  page session, and the chrome renderer's own (default) session. */
  sessions: () => Session[];
  /** Build the first-run app back up: new device identity, empty workspace,
   *  fresh services, reloaded chrome. */
  restart: () => Promise<void>;
}

/**
 * Stop → wipe → start again. A session that refuses to clear must not strand
 * the user in a half-signed-out app, so a failure there is logged and the
 * reset continues: the account files still go, and the app still comes back.
 */
export async function performSignOut(deps: SignOutDeps): Promise<void> {
  deps.stopServices();
  await Promise.all(
    deps.sessions().map((ses) =>
      clearSession(ses).catch((err: unknown) => {
        console.error("suma sign-out: session clear failed", err);
      }),
    ),
  );
  removeLocalState(deps.userDataDir);
  await deps.restart();
}
