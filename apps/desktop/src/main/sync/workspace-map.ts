/**
 * Pure workspace-sync logic (PRD §8.3 "Workspace-state synchronization"):
 * WorkspaceStore state ⇄ WorkspaceDoc mapping, the LWW+HLC merge decision for
 * incoming docs, and the seal/signature byte layouts. No Electron, no I/O —
 * unit tests exercise this module directly.
 */

import {
  encodeHlc,
  lengthPrefixed,
  mergeLww,
  settingsDocs,
  type ArchivedTab,
  type Hlc,
  type PinnedTab,
  type SpaceMeta,
  type WorkspaceDoc,
  type WorkspaceSettings,
} from "@suma/protocol";

/**
 * Workspace docs are account-global, so they seal under a dedicated account
 * workspace key: deriveSpaceKeys with this fixed pseudo-space id over the
 * per-account workspace secret (device.ts `workspaceSecret()`).
 */
export const WORKSPACE_PSEUDO_SPACE_ID = "__workspace__";

const SEAL_AAD_DOMAIN = "suma.workspace.seal.v1";
const SIG_DOMAIN = "suma.workspacesig.v1";

/** AAD binding a sealed workspace value to its doc key. */
export function workspaceSealAad(key: string): Uint8Array {
  return lengthPrefixed([SEAL_AAD_DOMAIN, key]);
}

/** Canonical bytes covered by a workspace record's device signature. */
export function workspaceSigningBytes(
  key: string,
  sealedValue: string | null,
  hlc: Hlc,
): Uint8Array {
  return lengthPrefixed([SIG_DOMAIN, key, sealedValue ?? "", encodeHlc(hlc)]);
}

/**
 * Snapshot-style globally synchronized categories. Realtime tab fields and
 * canonical focus are emitted incrementally by WorkspaceStore.
 */
export interface GlobalWorkspaceState {
  spaces: SpaceMeta[];
  pins: PinnedTab[];
  archives: ArchivedTab[];
  settings: WorkspaceSettings;
}

/** Map the globally-synced categories to their WorkspaceDocs. */
export function docsForState(state: GlobalWorkspaceState): WorkspaceDoc[] {
  return [
    ...state.spaces.map((space): WorkspaceDoc => ({ kind: "space", space })),
    ...state.pins.map((pin): WorkspaceDoc => ({ kind: "pin", pin })),
    ...state.archives.map(
      (archive): WorkspaceDoc => ({ kind: "archive", archive }),
    ),
    // Settings fan out to one independent LWW doc per field (§8.2).
    ...settingsDocs(state.settings),
  ];
}

/** A local workspace LWW register: null value ⇒ tombstone (deleted doc). */
export interface WorkspaceRegister {
  doc: WorkspaceDoc | null;
  hlc: Hlc;
}

/** An incoming (already-unsealed) remote workspace doc. */
export interface IncomingWorkspaceDoc {
  key: string;
  value: WorkspaceDoc | null;
  hlc: Hlc;
}

export interface MergeDecision {
  /** Remote winners to apply into local state (and adopt their HLC). */
  apply: IncomingWorkspaceDoc[];
  /**
   * Remote docs that win on HLC but whose value already equals local state —
   * adopt the HLC only. Applying nothing here is the echo suppression: a doc
   * that matches local state must never trigger a state change or republish.
   */
  adoptHlc: IncomingWorkspaceDoc[];
}

function docValueEquals(
  a: WorkspaceDoc | null,
  b: WorkspaceDoc | null,
): boolean {
  // Docs are plain data built by the same code paths, so JSON equality holds.
  return JSON.stringify(a) === JSON.stringify(b);
}

/** LWW+HLC (protocol mergeLww) decision for incoming docs vs local registers. */
export function decideMerge(
  local: Readonly<Record<string, WorkspaceRegister>>,
  incoming: readonly IncomingWorkspaceDoc[],
): MergeDecision {
  const apply: IncomingWorkspaceDoc[] = [];
  const adoptHlc: IncomingWorkspaceDoc[] = [];
  for (const doc of incoming) {
    const current = local[doc.key];
    if (current === undefined) {
      apply.push(doc);
      continue;
    }
    const incomingRegister = { value: doc.value, hlc: doc.hlc };
    if (
      mergeLww({ value: current.doc, hlc: current.hlc }, incomingRegister) !==
      incomingRegister
    ) {
      continue; // local wins (or equal HLC — merge is idempotent)
    }
    if (docValueEquals(current.doc, doc.value)) adoptHlc.push(doc);
    else apply.push(doc);
  }
  return { apply, adoptHlc };
}
