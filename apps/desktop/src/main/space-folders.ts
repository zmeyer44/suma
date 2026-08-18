/**
 * Space → folder naming for the shared filesystem ("one folder per space").
 *
 * A folder name is derived from the space's display name exactly once, when
 * the binding is first needed, then persisted in the synced WorkspaceStore.
 * Rename and collision handling are lookups against that map — never a
 * re-derivation — so devices can't disagree about where a space's files are.
 */

import { createHash } from "node:crypto";

/** Characters no filesystem (or vfs path segment) should be asked to hold. */
// eslint-disable-next-line no-control-regex
const UNSAFE = /[/\\:*?"<>|\u0000-\u001f]/g;

const MAX_FOLDER_CHARS = 64;

export function sanitizeSpaceFolderName(name: string): string {
  const cleaned = name
    .normalize("NFC")
    .replace(UNSAFE, "")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, MAX_FOLDER_CHARS)
    .replace(/[.\s]+$/g, "");
  return cleaned.length > 0 ? cleaned : "Space";
}

function collisionKey(folder: string): string {
  // The supported local root is normally case-insensitive APFS. Treat names
  // the same way even when tests or a remote agent happen to be case-sensitive.
  return folder.normalize("NFC").toLocaleLowerCase("en-US");
}

function stableSpaceSuffix(spaceId: string): string {
  return `--${createHash("sha256").update(spaceId).digest("hex").slice(0, 12)}`;
}

/**
 * Pick a deterministic folder for `name`. The space-id suffix matters even
 * when the local binding snapshot shows no collision: two offline devices can
 * allocate equally named spaces concurrently, and no snapshot can serialize
 * that decision. A stable suffix makes both same-space and different-space
 * allocations converge without relying on timing.
 */
export function pickSpaceFolder(
  existing: Readonly<Record<string, string>>,
  spaceId: string,
  name: string,
): string {
  const taken = new Set(
    Object.entries(existing)
      .filter(([id]) => id !== spaceId)
      .map(([, folder]) => collisionKey(folder)),
  );
  const suffix = stableSpaceSuffix(spaceId);
  const base = sanitizeSpaceFolderName(name)
    .slice(0, MAX_FOLDER_CHARS - suffix.length)
    .replace(/[.\s]+$/g, "");
  const desired = `${base.length > 0 ? base : "Space"}${suffix}`;
  if (!taken.has(collisionKey(desired))) return desired;
  for (let n = 2; ; n += 1) {
    const numberedSuffix = `${suffix}-${n}`;
    const numberedBase = sanitizeSpaceFolderName(name)
      .slice(0, MAX_FOLDER_CHARS - numberedSuffix.length)
      .replace(/[.\s]+$/g, "");
    const candidate = `${numberedBase.length > 0 ? numberedBase : "Space"}${numberedSuffix}`;
    if (!taken.has(collisionKey(candidate))) return candidate;
  }
}
