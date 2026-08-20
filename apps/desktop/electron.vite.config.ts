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

/**
 * @vitejs/plugin-react injects its React Refresh preamble as an INLINE
 * <script> prepended to <head> — ABOVE index.html's meta CSP, which is why
 * the meta never governed it and only the dev header ever did. Now that
 * DEV_CSP is byte-identical to the production meta (`script-src 'self'`,
 * see main/privileged.ts + test/csp-parity), that inline script is blocked,
 * the preamble never runs, and the first refresh-wrapped module throws
 * "@vitejs/plugin-react can't detect preamble" — React never mounts and the
 * renderer is a blank white window.
 *
 * Loosening dev CSP would reintroduce exactly the dev/prod gap csp-parity
 * exists to lock out, so serve the identical code as a same-origin module
 * instead: 'self' covers it, no policy changes, and the shipped build is
 * untouched because Vite only injects the preamble while serving.
 */
const REACT_PREAMBLE_URL = "/@suma-react-preamble";

function serveReactPreamble(): Plugin {
  let preamble = "";
  return {
    name: "suma-serve-react-preamble",
    apply: "serve",
    configResolved(config) {
      preamble = react.preambleCode.replace("__BASE__", config.base);
    },
    configureServer(server) {
      // Assert the shape HERE rather than in transformIndexHtml: the html
      // hook also runs during Vite's cold-start dependency scan, where
      // plugin-react has not injected anything yet, and a throw there is
      // swallowed by Vite's own error reporter (it crashes on
      // `entries.join` before printing the cause). This check is html-
      // independent, runs once, and still fails loudly on a plugin-react
      // change that would otherwise hand us a blank renderer.
      if (!preamble.includes("injectIntoGlobalHook")) {
        throw new Error(
          "suma-serve-react-preamble: @vitejs/plugin-react's preambleCode no " +
            "longer looks like the React Refresh preamble. Update this " +
            "plugin, or dev starts with a blank renderer under " +
            "`script-src 'self'` (see main/privileged.ts DEV_CSP).",
        );
      }
      // Registered from the hook body, so it lands ahead of Vite's own
      // middlewares and answers before the transform pipeline sees the path.
      server.middlewares.use(REACT_PREAMBLE_URL, (_req, res) => {
        res.setHeader("Content-Type", "text/javascript");
        res.setHeader("Cache-Control", "no-cache");
        res.end(preamble);
      });
    },
    transformIndexHtml: {
      // After plugin-react has injected the tag we are replacing.
      order: "post",
      handler(html) {
        const inline = `<script type="module">${preamble}</script>`;
        // A no-op when absent on purpose: the dep scanner runs this hook on
        // the raw index.html, long before any preamble exists to rewrite.
        return html.includes(inline)
          ? html.replace(
              inline,
              `<script type="module" src="${REACT_PREAMBLE_URL}"></script>`,
            )
          : html;
      },
    },
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
    plugins: [react(), serveReactPreamble(), tailwindcss()],
    build: {
      rollupOptions: {
        input: { index: "src/renderer/index.html" },
      },
    },
  },
});
