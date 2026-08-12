# apps/files — the `suma://files` UI

The in-browser Files app (PRD §8.6, V1 = M-3 Lite). React + Vite + Tailwind v4,
built to `dist/` as a relative-path bundle and served by the desktop app from
the privileged `suma://files` scheme in a hardened WebContents — no Node
integration, sandboxed, strict CSP, navigation locked to the scheme (§8.1).

## What it does

- **Browse** the tree, built from a flat `FileEntry[]` (`src/lib/tree.ts`).
- **Preview** text and images inline; everything else shows its type and size
  and reads no bytes at all (`src/lib/preview.ts`).
- **Upload** with progress, from the toolbar or by dropping onto the tree.
  Uploads land in the selected directory, which the tree footer always names.
- **Download** a file (hydrated from the chunk cache by the main process) and
  **delete** one, behind a confirm step.
- **Quota meter** with used / limit and the soft-block state: at the limit the
  Upload button is disabled and the copy says plainly that nothing already
  stored was removed (`checkQuota` semantics — §8.6, Pro 100 GB).
- **Transfers**: uploads from this Mac and cloud fetches, each with progress,
  and each fetch labelled with the device that started it, so a second Mac can
  see where the work came from.

## What it deliberately does not say

Three claims this UI must never make, because they are not true in V1:

1. **The whole home directory is not "in the cloud."** Only `~/cloud` is
   cloud-native (JuiceFS-backed, canonical in R2). `$HOME` is a Fly NVMe volume
   with continuous incremental snapshots. The footer says exactly that.
2. **`$HOME` is not end-to-end encrypted in V1.** The footer carries a standing
   badge saying so rather than leaving it to be inferred. See
   `docs/security-model.md`.
3. **Suma cannot fetch authenticated downloads in the cloud.** §8.6 deleted
   the v1.0 "sealed one-shot request". Only credential-free requests — public
   or presigned URLs — are eligible, `cloudFetchEligibility` is the enforcement
   point in the main process, and the transfers panel states the rule right
   where the fetches are listed.

## The bridge

Everything privileged crosses `window.sumaFiles`, defined **as types only**
in `src/bridge.ts` — the desktop stream owns the implementation and injects it
from the preload. This app never touches the network itself; its CSP has no
remote origins at all.

The mapping to the Phase-3 IPC channels is in the header comment of
`src/bridge.ts`. Three members are not in the spec's channel list, so they were
added to it deliberately rather than assumed:

| bridge member          | channel                | why it exists                                             |
| ---------------------- | ---------------------- | --------------------------------------------------------- |
| `read(path, maxBytes)` | `files:read`           | inline preview needs a **bounded** byte range              |
| `context()`            | `files:context`        | resolves `Transfer.originDeviceId` to a device name        |
| `onUploadProgress`     | `files:uploadProgress` | `upload()` resolves only at the end; progress needs a feed |

`src/channel-bridge.ts` builds this bridge over the desktop's allowlisted
channel API (`{ invoke, on }`) for the preload generation that injects the raw
channels; a preload that injects the method bridge directly is passed through
untouched. Either way the allowlist stays in the preload, where a page bug
cannot widen it.

`src/mock-bridge.ts` is a fixture implementation so `vite build` and a
standalone `vite dev` work without Electron; `src/bridge-source.ts` adapts the
injected bridge when it exists and falls back to the mock otherwise. When the
mock is in use the toolbar shows a **Mock data** badge — a Files app that
cannot tell you whether it is showing your real files is worse than useless.

Mock states, for looking at the edges without Electron:

- `?mock=full` — starts at the quota limit (soft-blocked).
- `?mock=empty` — starts with nothing stored.

## Layout

```
src/
  bridge.ts          window.sumaFiles contract (types only)
  bridge-source.ts   injected bridge, or the mock
  channel-bridge.ts  adapter: the bridge, built over the raw IPC channels
  mock-bridge.ts     standalone fixture
  state.ts           the one stateful hook (useFilesApp)
  App.tsx            layout + the standing honesty footer
  App.test.ts        copy guards for the three claims above (static markup,
                     no DOM environment needed)
  components/        tree, preview, transfers, quota meter, status banner
  lib/               pure logic: tree building, formatting, preview planning,
                     quota presentation — each with colocated tests
```

Shared contracts come from `@suma/protocol` (`FileEntry`, `Transfer`,
`checkQuota`, `PRO_QUOTA_BYTES`, `normalizeVfsPath`); none of them is
reimplemented here. Byte formatting is 1024-based on purpose, so the meter
agrees with `checkQuota`'s "100 GB" wording, which is derived from
`limitBytes / 1024 ** 3`.

## Known gaps

- Downloads report where the file landed but not incremental progress: the
  bridge resolves once, at the end. Adding a hydration progress event would be
  a bridge change, not a UI change.
- Uploads pass whole file contents through the bridge. That is fine for the
  sizes this UI targets; a path-based handoff would be the next step for very
  large local files.

## Explicitly out of V1

Finder File Provider extension, dataless placeholders, two-way local editing,
versioning, share links — deferred to V1.1+ and demand-gated (§8.6).

## Verify

```
pnpm --filter @suma/files check-types
pnpm --filter @suma/files test
pnpm --filter @suma/files build
pnpm --filter @suma/files lint
```
