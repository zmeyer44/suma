import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { OverlayStack } from "./components/OverlayStack";
import { SelectionToolbar } from "./components/SelectionToolbar";
import { VideoPip } from "./components/VideoPip";
import { attachAudioOverlayBridge, setAudioNotifier } from "./lib/audio";
import { initTheme, initThemePaintOnly } from "./lib/theme";
import { useSumaStore } from "./store";
import "./styles.css";

const rootEl = document.getElementById("root");
if (rootEl === null) throw new Error("renderer: #root element missing");

// The bundle serves two surfaces (shell-window.ts): the chrome, and the
// floating overlay — a transparent WebContentsView above the tab views,
// addressed by hash. The overlay renders ONLY the floating stack (the audio
// player and the save-preview cards): no store, no App effects, nothing that
// would fight the real chrome over shared state — and it PAINTS the shared
// theme without asserting it to main (those channels are chrome-only).
if (window.location.hash === "#save-preview") {
  initThemePaintOnly();
  createRoot(rootEl).render(
    <StrictMode>
      <OverlayStack />
    </StrictMode>,
  );
} else if (window.location.hash === "#selection-toolbar") {
  // Third surface, same bundle: the floating selection toolbar, another
  // transparent view above the tab pages. Like the overlay stack it paints
  // the shared theme without asserting it to main.
  initThemePaintOnly();
  createRoot(rootEl).render(
    <StrictMode>
      <SelectionToolbar />
    </StrictMode>,
  );
} else if (window.location.hash === "#video-pip") {
  // Fourth surface: the floating video player, a freely-positioned view
  // above the tab pages. It owns its <video>; main owns its geometry.
  initThemePaintOnly();
  createRoot(rootEl).render(
    <StrictMode>
      <VideoPip />
    </StrictMode>,
  );
} else {
  // Before the first paint, so the stored palette never flashes the default.
  initTheme();
  // The audio player outlives every component, so it cannot import the toast
  // stack — it is handed a way to speak up instead (lib/audio.ts).
  setAudioNotifier((message, type) => {
    useSumaStore.getState().pushToast(message, type);
  });
  // The player's controls live in the overlay window; this is their line to
  // the real audio element (see lib/audio.ts).
  attachAudioOverlayBridge(() => {
    void useSumaStore.getState().openSettings("voice");
  });

  createRoot(rootEl).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
