// npm tarballs don't preserve file modes, so node-pty's prebuilt
// `spawn-helper` lands without its execute bit under pnpm — and every PTY
// spawn then fails with `posix_spawnp failed`. Restore it after install.
import { chmodSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

let root;
try {
  root = dirname(require.resolve("node-pty/package.json"));
} catch {
  process.exit(0); // not installed (e.g. pruned CI) — nothing to fix
}

let platforms = [];
try {
  platforms = readdirSync(join(root, "prebuilds"));
} catch {
  process.exit(0); // built from source — node-gyp sets modes correctly
}

for (const platform of platforms) {
  try {
    chmodSync(join(root, "prebuilds", platform, "spawn-helper"), 0o755);
  } catch {
    // Windows prebuilds have no spawn-helper.
  }
}
