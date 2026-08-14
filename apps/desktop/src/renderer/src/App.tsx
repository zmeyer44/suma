import { useEffect } from "react";
import { CertErrorBanner } from "./components/CertErrorBanner";
import { ChatSidebar } from "./components/ChatSidebar";
import { CommandBar } from "./components/CommandBar";
import { ContentPanes } from "./components/ContentPanes";
import { CredentialFill } from "./components/CredentialFill";
import { DownloadsPanel } from "./components/DownloadsPanel";
import { GlanceOverlay } from "./components/GlanceOverlay";
import { ImagePreviewModal } from "./components/ImagePreviewModal";
import { BypassSuggestions, EgressBanner } from "./components/EgressBanner";
import { MigrationWizard } from "./components/MigrationWizard";
import { OnboardingWizard } from "./components/OnboardingWizard";
import { NostrRequestPanel } from "./components/NostrRequestPanel";
import { OriginControls } from "./components/OriginControls";
import { PasskeyPicker } from "./components/PasskeyPicker";
import { SavesPanel } from "./components/SavesPanel";
import { DegradedBanner } from "./components/StatusPills";
import { TabPreviewStrip } from "./components/TabPreviewStrip";
import { TabStrip } from "./components/TabStrip";
import { UrlBar } from "./components/UrlBar";
import { VideosPanel } from "./components/VideosPanel";
import { WorkspaceSyncDialog } from "./components/WorkspaceReattachDialog";
import { Toaster } from "./components/ui/toast";
import { selectActiveTab, useSumaStore } from "./store";

export function App() {
  const hydrate = useSumaStore((s) => s.hydrate);
  const attachEvents = useSumaStore((s) => s.attachEvents);
  const toggleCommandBar = useSumaStore((s) => s.toggleCommandBar);
  const toggleChat = useSumaStore((s) => s.toggleChat);
  const toggleSaves = useSumaStore((s) => s.toggleSaves);
  const toggleVideos = useSumaStore((s) => s.toggleVideos);
  const setOverlay = useSumaStore((s) => s.setOverlay);
  const openSettings = useSumaStore((s) => s.openSettings);
  const createTab = useSumaStore((s) => s.createTab);
  const openUrlBar = useSumaStore((s) => s.openUrlBar);
  const reload = useSumaStore((s) => s.reload);
  const goBack = useSumaStore((s) => s.goBack);
  const goForward = useSumaStore((s) => s.goForward);

  useEffect(() => attachEvents(), [attachEvents]);
  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  // §8.1: tab WebContentsViews sit ABOVE this page, so any modal drawn here
  // is invisible until main raises the chrome view. Report exactly the states
  // that put a modal over the content hole.
  // paneResizing rides the same mechanism: a divider drag needs the chrome on
  // top so pointer moves crossing the panes aren't swallowed by the sites.
  // tabDragging is the same story for a tab dragged out of the strip.
  const modalOpen = useSumaStore(
    (s) =>
      s.overlay !== "none" ||
      s.originPopover !== null ||
      s.statusPopoverOpen ||
      s.passkeyRequest !== null ||
      s.chatImagePreview !== null ||
      s.glance !== null ||
      s.wizardOpen ||
      s.paneResizing ||
      s.tabDragging,
  );
  const reportOverlayActive = useSumaStore((s) => s.reportOverlayActive);
  useEffect(() => {
    reportOverlayActive(modalOpen);
  }, [modalOpen, reportOverlayActive]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.metaKey || e.altKey || e.ctrlKey) return;
      const key = e.key.toLowerCase();
      if (key === "k") {
        e.preventDefault();
        toggleCommandBar();
      } else if (key === "t") {
        e.preventDefault();
        void createTab();
      } else if (key === "w" && !e.shiftKey) {
        e.preventDefault();
        const state = useSumaStore.getState();
        // A glance is the topmost page-like surface — ⌘W closes it, not the
        // tab it is covering.
        if (state.glance !== null) {
          void state.closeGlance();
          return;
        }
        const active = selectActiveTab(state);
        if (active !== null) void state.closeTab(active.id);
      } else if (key === "j" && e.shiftKey) {
        e.preventDefault();
        setOverlay("downloads");
      } else if (key === "l") {
        e.preventDefault();
        openUrlBar();
      } else if (key === "r") {
        e.preventDefault();
        void reload();
      } else if (key === ",") {
        e.preventDefault();
        void openSettings();
      } else if (key === "i") {
        e.preventDefault();
        toggleChat();
      } else if (key === "b") {
        e.preventDefault();
        toggleSaves();
      } else if (key === "v" && e.shiftKey) {
        e.preventDefault();
        toggleVideos();
      } else if (key === "[") {
        e.preventDefault();
        void goBack();
      } else if (key === "]") {
        e.preventDefault();
        void goForward();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    toggleCommandBar,
    toggleChat,
    toggleSaves,
    toggleVideos,
    createTab,
    openUrlBar,
    reload,
    setOverlay,
    openSettings,
    goBack,
    goForward,
  ]);

  return (
    <div className="flex h-full flex-col bg-transparent text-text">
      <TabStrip />
      {/* The hover preview shelf: a layout sibling like the banners below, so
          opening it shrinks the content hole and the page slides down under
          it (ContentPanes re-reports the bounds; main tracks the views). */}
      <TabPreviewStrip />
      {/* Playback controls are NOT here: they live in the floating overlay
          window (AudioPlayer.tsx via OverlayStack), which stays visible above
          any open page — a control in the chrome would be covered by the tab
          views. */}
      <DegradedBanner />
      <EgressBanner />
      <CertErrorBanner />
      {/* The sidebar is a SIBLING of the content hole, not an overlay: it
          takes real layout width, so the hole narrows and main resizes the
          tab views onto the smaller region (ContentPanes reports it). */}
      <div className="flex min-h-0 flex-1">
        <ContentPanes />
        <ChatSidebar />
        <SavesPanel />
        <VideosPanel />
        <NostrRequestPanel />
      </div>

      <OriginControls />
      <CommandBar />
      <UrlBar />
      <MigrationWizard />
      <DownloadsPanel />
      <ImagePreviewModal />
      {/* The Glance preview frame — the page itself is a floating view main
          layers over the content hole this draws (GlanceOverlay.tsx). */}
      <GlanceOverlay />
      <CredentialFill />
      <WorkspaceSyncDialog />
      <OnboardingWizard />
      {/* Above every other overlay: a pending ceremony blocks the page until
          it is answered. */}
      <PasskeyPicker />

      {/* The bottom-left notification stack. The chrome view renders BELOW
          the tab WebContentsViews, so a card anchored over the content hole
          is invisible whenever a tab is open. With the top-bar layout there
          is no always-visible side column, so passive cards (bypass
          suggestions, toasts) only show when no tab is open or the chrome is
          raised for a modal — raising the chrome just for them would steal
          clicks from the page. */}
      <div className="pointer-events-none fixed bottom-3 left-3 z-50 flex w-[320px] flex-col gap-2">
        <BypassSuggestions />
        {/* Last in the column so the toast pile grows up from the corner.
            Its viewport collapses to zero height when empty. */}
        <Toaster />
      </div>
    </div>
  );
}
