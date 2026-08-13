/**
 * The updater's state machine, pure and separate from electron-updater so it
 * can be tested (test/update-core.test.ts) — the same split as
 * voice-core/tts-core. update-service.ts translates electron-updater events
 * into UpdateEvents and feeds them through `reduceUpdate`.
 *
 * The one rule that earns this file its existence: a STAGED UPDATE IS NEVER
 * UN-STAGED. Once a download completes, the bytes sit next to the app and
 * install on quit no matter what later checks say — so a failed periodic
 * re-check (offline overnight, GitHub hiccup) must not knock `ready` back to
 * `error` and hide the "Restart to update" button behind a scary message.
 * From `ready`, the only exits are installing it or a NEWER version starting
 * to download over it.
 */

import type { UpdateState } from "../../shared/updates";

export type UpdateEvent =
  | { kind: "checking" }
  | { kind: "not-available"; at: number }
  | { kind: "available"; version: string }
  | { kind: "progress"; percent: number }
  | { kind: "downloaded"; version: string; at: number }
  | { kind: "error"; message: string };

export function reduceUpdate(
  state: UpdateState,
  event: UpdateEvent,
): UpdateState {
  // Terminal by construction — a dev build does not become updatable.
  if (state.phase === "unsupported") return state;

  switch (event.kind) {
    case "checking":
      // Keep the staged version visible; the check runs behind it.
      if (state.phase === "ready") return state;
      return { ...state, phase: "checking", error: null };

    case "not-available":
      if (state.phase === "ready") return { ...state, checkedAt: event.at };
      return {
        ...state,
        phase: "idle",
        availableVersion: null,
        percent: null,
        checkedAt: event.at,
        error: null,
      };

    case "available":
      // Same version already staged → nothing new to download.
      if (state.phase === "ready" && state.availableVersion === event.version)
        return state;
      return {
        ...state,
        phase: "downloading",
        availableVersion: event.version,
        percent: 0,
        error: null,
      };

    case "progress": {
      if (state.phase !== "downloading") return state;
      const percent = Math.min(100, Math.max(0, event.percent));
      return { ...state, percent };
    }

    case "downloaded":
      return {
        ...state,
        phase: "ready",
        availableVersion: event.version,
        percent: null,
        checkedAt: event.at,
        error: null,
      };

    case "error":
      // The staged-update rule: ready survives every later failure.
      if (state.phase === "ready") return state;
      return {
        ...state,
        phase: "error",
        percent: null,
        error: event.message,
      };
  }
}
