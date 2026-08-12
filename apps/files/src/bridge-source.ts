/**
 * Which bridge is this window actually talking to?
 *
 * Inside Electron the preload has already put the real one on `window`. Run
 * standalone (`vite dev`, or the built bundle opened directly) there is
 * nothing there, and we fall back to the fixture — flagged, never disguised.
 */

import type { SumaFilesBridge } from "./bridge";
import { adaptBridge } from "./channel-bridge";
import { MockBridge, type MockBridgeOptions } from "./mock-bridge";

export interface ResolvedBridge {
  bridge: SumaFilesBridge;
  /** True when the data on screen is a fixture, not this user's Files. */
  isMock: boolean;
}

/** `?mock=full` starts at the quota limit, `?mock=empty` starts with nothing. */
function mockOptionsFromSearch(search: string): MockBridgeOptions {
  const mode = new URLSearchParams(search).get("mock");
  return { full: mode === "full", empty: mode === "empty" };
}

export function resolveBridge(): ResolvedBridge {
  const injected = typeof window === "undefined" ? undefined : window.sumaFiles;
  // Whatever the preload injected — the typed bridge, or the allowlisted
  // channel API it is built from — the UI gets the typed bridge (see
  // channel-bridge.ts).
  if (injected !== undefined) return { bridge: adaptBridge(injected), isMock: false };
  const search = typeof window === "undefined" ? "" : window.location.search;
  return { bridge: new MockBridge(mockOptionsFromSearch(search)), isMock: true };
}
