import { copyFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import type { Plugin } from "vite";

/**
 * The NIP-07 guest preload runs in SANDBOXED tab renderers, which cannot
 * load an ESM preload — and this package's preload build emits .mjs. It is
 * a single dependency-free CJS file on purpose, copied verbatim instead of
 * bundled (see src/preload/nostr-guest.cjs).
 */
function copyNostrGuestPreload(): Plugin {
  const copy = (): void => {
    const outDir = resolve(__dirname, "out/preload");
    mkdirSync(outDir, { recursive: true });
    copyFileSync(
      resolve(__dirname, "src/preload/nostr-guest.cjs"),
      resolve(outDir, "nostr-guest.cjs"),
    );
  };
  return {
    name: "copy-nostr-guest-preload",
    // Both hooks on purpose: buildStart lands the file the moment the dev
    // watcher spins up (main may register the preload before the first
    // bundle finishes), closeBundle refreshes it on every rebuild.
    buildStart: copy,
    closeBundle: copy,
  };
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ["@suma/protocol", "@suma/config", "@suma/sync-engine"] })],
    build: {
      rollupOptions: {
        input: { index: "src/main/index.ts" },
      },
    },
  },
  preload: {
    plugins: [
      externalizeDepsPlugin({ exclude: ["@suma/protocol", "@suma/config", "@suma/sync-engine"] }),
      copyNostrGuestPreload(),
    ],
    build: {
      rollupOptions: {
        input: { index: "src/preload/index.ts" },
      },
    },
  },
  renderer: {
    plugins: [react(), tailwindcss()],
    build: {
      rollupOptions: {
        input: { index: "src/renderer/index.html" },
      },
    },
  },
});
