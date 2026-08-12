/**
 * Registers the NIP-07 guest preload (preload/nostr-guest.cjs) on a space
 * session, so every tab AND every auth popup riding that session gets
 * `window.nostr`. Session-level registration rather than a `preload:` entry
 * in tabs.ts because popups are built elsewhere (popups.ts) and a signer
 * that vanishes inside an OAuth window would be a debugging séance.
 *
 * Guarded per session: `session.fromPartition` caches by partition name, so
 * a session object can outlive one service graph (sign-out rebuild), and
 * registering twice would run the preload twice — the second
 * `contextBridge.exposeInMainWorld("nostr", …)` throws in every frame.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Session } from "electron";

const dirname = path.dirname(fileURLToPath(import.meta.url));

const registered = new WeakSet<Session>();

export function registerNostrGuestPreload(ses: Session): void {
  if (registered.has(ses)) return;
  registered.add(ses);
  const filePath = path.join(dirname, "../preload/nostr-guest.cjs");
  if (!existsSync(filePath)) {
    // Say it NOW, out loud: registerPreloadScript itself accepts a missing
    // file and every page then silently loads without window.nostr — which
    // presents as "Nostr sign-in options never appear", nothing pointing
    // here. (The copy step in electron.vite.config.ts is what produces it.)
    console.error(`suma nostr: guest preload missing at ${filePath} — window.nostr will not be injected`);
    return;
  }
  ses.registerPreloadScript({ type: "frame", filePath });
}
