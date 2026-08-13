/**
 * App self-update state (shared/ipc.ts `updates:*`).
 *
 * The updater itself — electron-updater against the zmeyer44/suma GitHub
 * releases feed — runs entirely in MAIN (main/updates/update-service.ts).
 * The renderer only ever sees this snapshot: the About settings page renders
 * it, and `updates:changed` pushes each transition. Nothing here can move
 * bytes; the only renderer-triggerable actions are "check now" and "restart
 * into the downloaded version".
 */

/**
 * Where the updater is in its cycle. `idle` covers both "haven't checked
 * yet" (checkedAt null) and "checked, already current" (checkedAt set) —
 * "up to date" is a fact about the last check, not a distinct machine state.
 * `unsupported` is terminal: dev builds and unpackaged runs never update.
 */
export type UpdatePhase =
  | "idle"
  | "checking"
  | "downloading"
  | "ready"
  | "error"
  | "unsupported";

export interface UpdateState {
  phase: UpdatePhase;
  /** The running build — also the About page's version row. */
  currentVersion: string;
  /** The version being downloaded (`downloading`) or staged (`ready`). */
  availableVersion: string | null;
  /** Download progress 0–100, only meaningful while `downloading`. */
  percent: number | null;
  /** Epoch ms of the last COMPLETED check (found one or not); null before. */
  checkedAt: number | null;
  /** Human-readable failure, only while `error`. */
  error: string | null;
}

export function initialUpdateState(
  currentVersion: string,
  supported: boolean,
): UpdateState {
  return {
    phase: supported ? "idle" : "unsupported",
    currentVersion,
    availableVersion: null,
    percent: null,
    checkedAt: null,
    error: null,
  };
}
