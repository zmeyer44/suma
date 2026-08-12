import { Unicode11Addon } from "@xterm/addon-unicode11";
import {
  FileCode,
  PanelLeft,
  Plus,
  SquareTerminal,
  Terminal as TerminalIcon,
  X,
  type LucideIcon,
} from "lucide-react";
import { WebglAddon } from "@xterm/addon-webgl";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal, type ITheme } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";
import { cn } from "../lib/cn";
import {
  accruedCostLabel,
  jobModeLabel,
  RECONSTRUCTED_BANNER,
} from "../lib/compute";
import {
  EXPLORER_DEFAULT_WIDTH,
  EXPLORER_MAX_WIDTH,
  EXPLORER_MIN_WIDTH,
  TERMINAL_DEFAULT_HEIGHT,
  TERMINAL_MAX_HEIGHT,
  TERMINAL_MIN_HEIGHT,
} from "../lib/ide";
import { useSumaStore } from "../store";
import { IdeEditor } from "./IdeEditor";
import { IdeExplorer } from "./IdeExplorer";
import { IdeResizeHandle } from "./IdeResizeHandle";
import { PortChips } from "./PortChips";
import "@xterm/xterm/css/xterm.css";

/**
 * `suma://terminal` — the Suma terminal (PRD §8.5) as a PAGE, grown into a
 * VS Code-shaped IDE: file explorer on the left, editor and shell stacked in
 * the main column, each panel hideable from the toolbar and resizable at its
 * seam (IdeResizeHandle). Explorer and editor are @pierre/trees and
 * @pierre/diffs over main's WorkspaceFsService; the shell is unchanged
 * underneath.
 *
 * It is a browser tab, not a modal: a shell is somewhere you work for an hour,
 * not something summoned over the page you were reading. So it lives in the
 * strip, takes the whole content hole, keeps its place when you switch away
 * and back, and can be dropped into a split beside the app it is building.
 * Like `suma://settings` it is drawn by the CHROME renderer into the hole
 * rather than by a document of its own (shared/internal-pages.ts), which is
 * why it can read the same live store as the rest of the chrome — and why it
 * paints its own opaque surface, since the hole under it is transparent.
 *
 * The output pane is the PRD's xterm.js client (WebGL renderer when the GPU
 * cooperates), fed raw bytes by terminal:data — full VT emulation, so TUIs
 * (claude, vim, htop) render as they would in a native terminal. One Terminal
 * instance serves all shells: attach replays the whole scrollback, so
 * switching shells is reset-then-replay, same as reconnects. That is also what
 * makes the page cheap to unmount — leaving the tab and coming back rebuilds
 * the screen from the agent's scrollback ring, exactly like a reconnect. The
 * same replay covers hiding and reshowing the terminal PANEL, which unmounts
 * the xterm host in place.
 */

/** Matches the agent-side scrollback ring so replay never over/underflows. */
const SCROLLBACK_LINES = 5_000;

/**
 * Theme colors for xterm, resolved from the chrome's palette. The palette
 * lives in CSS custom properties built with relative-color oklch() math, so
 * the values must round-trip through the CSSOM (a probe span resolves the
 * var + oklch to a concrete color) and a canvas context (which normalizes
 * any resolved color to #rrggbb — xterm's parser does not speak oklch).
 */
function resolveTheme(): ITheme {
  const probe = document.createElement("span");
  probe.style.display = "none";
  document.body.appendChild(probe);
  const ctx = document.createElement("canvas").getContext("2d");
  const color = (variable: string, fallback: string): string => {
    if (ctx === null) return fallback;
    probe.style.color = `var(${variable})`;
    ctx.fillStyle = fallback;
    ctx.fillStyle = getComputedStyle(probe).color;
    return typeof ctx.fillStyle === "string" ? ctx.fillStyle : fallback;
  };
  const bg = color("--color-bg", "#0a0c10");
  const text = color("--color-text", "#e6e8ec");
  const accent = color("--color-accent", "#588bff");
  probe.remove();
  return {
    background: bg,
    foreground: text,
    cursor: text,
    cursorAccent: bg,
    selectionBackground: `${accent}4d`,
  };
}

function monoFontFamily(): string {
  const family = getComputedStyle(document.documentElement)
    .getPropertyValue("--font-mono")
    .trim();
  return family.length > 0 ? family : "ui-monospace, Menlo, monospace";
}

export function TerminalPage() {
  const terminals = useSumaStore((s) => s.terminals);
  const machine = useSumaStore((s) => s.machine);
  const discoverTerminals = useSumaStore((s) => s.discoverTerminals);
  const refreshPorts = useSumaStore((s) => s.refreshPorts);
  const refreshMachine = useSumaStore((s) => s.refreshMachine);
  const createTerminal = useSumaStore((s) => s.createTerminal);
  const attachTerminal = useSumaStore((s) => s.attachTerminal);
  const closeTerminal = useSumaStore((s) => s.closeTerminal);
  const setJobMode = useSumaStore((s) => s.setJobMode);
  const sendTerminalInput = useSumaStore((s) => s.sendTerminalInput);
  const resizeTerminal = useSumaStore((s) => s.resizeTerminal);
  const pendingPtyId = useSumaStore((s) => s.pendingPtyId);
  const consumePendingTerminal = useSumaStore((s) => s.consumePendingTerminal);

  const explorerOpen = useSumaStore((s) => s.ideExplorerOpen);
  const editorOpen = useSumaStore((s) => s.ideEditorOpen);
  const terminalOpen = useSumaStore((s) => s.ideTerminalOpen);
  const explorerWidth = useSumaStore((s) => s.ideExplorerWidth);
  const terminalHeight = useSumaStore((s) => s.ideTerminalHeight);
  const toggleIdePanel = useSumaStore((s) => s.toggleIdePanel);
  const setIdeExplorerWidth = useSumaStore((s) => s.setIdeExplorerWidth);
  const setIdeTerminalHeight = useSumaStore((s) => s.setIdeTerminalHeight);
  const refreshWorkspaceTree = useSumaStore((s) => s.refreshWorkspaceTree);

  const [activePty, setActivePty] = useState<string | null>(null);

  /** Geometry anchors for the splitters' pointer→size math. */
  const middleRowRef = useRef<HTMLDivElement | null>(null);
  const mainColRef = useRef<HTMLDivElement | null>(null);

  const activePtyRef = useRef<string | null>(null);
  const termRef = useRef<Terminal | null>(null);
  // State, not a ref: the callback ref re-renders when the host div lands, and
  // the effect that builds the Terminal onto it runs then. A ref alone would
  // still be null on the mount pass that has to attach it.
  const [hostEl, setHostEl] = useState<HTMLDivElement | null>(null);

  /** Attach replays the whole scrollback, so the display resets first. */
  const selectPty = (ptyId: string): void => {
    // Eager, not render-time: replayed terminal:data can beat the re-render.
    activePtyRef.current = ptyId;
    termRef.current?.reset();
    setActivePty(ptyId);
    void attachTerminal(ptyId);
  };

  /**
   * True once a built terminal has been torn down while the page stayed
   * mounted — i.e. the terminal PANEL was hidden. The next build must
   * re-attach to replay the scrollback the dead instance took with it. The
   * initial mount stays false, because the discovery effect below owns the
   * first attach.
   */
  const needsReattach = useRef(false);

  // The xterm instance lives for one visit to the page (or one showing of the
  // terminal panel): unmounting tears it down, and attach-replay rebuilds the
  // screen when it comes back.
  useEffect(() => {
    if (hostEl === null) return;
    const host = hostEl;

    const term = new Terminal({
      allowProposedApi: true, // Unicode11Addon is a proposed API
      cursorBlink: true,
      fontSize: 12,
      fontFamily: monoFontFamily(),
      scrollback: SCROLLBACK_LINES,
      theme: resolveTheme(),
    });
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = "11";
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch {
      // No WebGL (headless GPU, driver blocklist) — the DOM renderer is fine.
    }

    // ⌘ shortcuts belong to the app, not the shell. Paste falls through to
    // the editMenu role (a native paste event xterm consumes); copy cannot —
    // xterm selection is not DOM selection — so it is served here.
    term.attachCustomKeyEventHandler((ev) => {
      if (!ev.metaKey) return true;
      if (ev.type === "keydown" && ev.key === "c" && term.hasSelection()) {
        void navigator.clipboard.writeText(term.getSelection());
      }
      return false;
    });

    const data = term.onData((chunk) => {
      const pty = activePtyRef.current;
      if (pty !== null) sendTerminalInput(pty, chunk);
    });
    const resize = term.onResize(({ cols, rows }) => {
      const pty = activePtyRef.current;
      if (pty !== null) resizeTerminal(pty, cols, rows);
    });
    fit.fit();
    const ro = new ResizeObserver(() => fit.fit());
    ro.observe(host);

    // Follow live theme flips: the IDE panels around this pane re-theme via
    // var() references, and a creation-time-only xterm palette would sit in
    // the old scheme beside them until the next mount.
    const themeObserver = new MutationObserver(() => {
      term.options.theme = resolveTheme();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });

    termRef.current = term;
    // Discovery may already have picked a pty before the host div landed.
    const pty = activePtyRef.current;
    if (pty !== null) {
      resizeTerminal(pty, term.cols, term.rows);
      term.focus();
      if (needsReattach.current) {
        // Fresh instance, so no reset needed before the replay lands.
        void attachTerminal(pty);
      }
    }
    needsReattach.current = false;
    return () => {
      ro.disconnect();
      themeObserver.disconnect();
      data.dispose();
      resize.dispose();
      termRef.current = null;
      term.dispose();
      needsReattach.current = true;
    };
  }, [hostEl, sendTerminalInput, resizeTerminal, attachTerminal]);

  useEffect(() => {
    if (!window.suma) return;
    const off = window.suma.on("terminal:data", ({ ptyId, data }) => {
      // Shells that are not on screen drop their bytes; attach replays
      // scrollback anyway.
      if (ptyId === activePtyRef.current) termRef.current?.write(data);
    });
    return off;
  }, []);

  useEffect(() => {
    void refreshMachine();
    void refreshPorts();
    // The explorer's listing is fetched once per app session; the refresh
    // button re-walks on demand.
    if (useSumaStore.getState().workspaceTree === null)
      void refreshWorkspaceTree();
    // Claimed synchronously, before any await: the strip's "New terminal"
    // button opens this page by creating the shell first, and the claim must
    // not race the effect below (which is why the read is atomic).
    const requested = consumePendingTerminal();
    // It already exists — createTerminal put it in the store — so attach now
    // rather than waiting on a discovery round-trip to name it back to us.
    if (requested !== null) {
      selectPty(requested);
      const s = useSumaStore.getState();
      if (!s.ideTerminalOpen) s.toggleIdePanel("terminal");
    }
    void (async () => {
      // Discovery, not just the local list: sessions started on another
      // device (or surviving a cold boot) become attachable shells here (§8.5).
      let list = await discoverTerminals();
      if (requested !== null) return;
      if (list.length === 0) {
        const created = await createTerminal();
        list = created === undefined ? [] : [created];
      }
      const current = activePtyRef.current;
      const target =
        list.find((t) => t.ptyId === current) ??
        list.find((t) => !t.exited) ??
        list[0];
      if (target !== undefined) selectPty(target.ptyId);
    })();
    // selectPty/refresh* are stable store actions; run once per visit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * "New terminal" pressed while this page is ALREADY open: the strip created
   * the shell and left its id in the store. The first run is skipped because
   * the mount effect above owns that pass — and it claimed the id there.
   */
  const claimedOnMount = useRef(false);
  useEffect(() => {
    if (!claimedOnMount.current) {
      claimedOnMount.current = true;
      return;
    }
    if (pendingPtyId === null) return;
    const requested = consumePendingTerminal();
    if (requested !== null) {
      selectPty(requested);
      // Asking for a new shell is asking to SEE a shell — unhide the panel.
      const s = useSumaStore.getState();
      if (!s.ideTerminalOpen) s.toggleIdePanel("terminal");
    }
    // selectPty is stable for this purpose; the id is the whole trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingPtyId, consumePendingTerminal]);

  // A fresh attach inherits whatever size the pty had; push the pane's real
  // grid and land the keyboard in the shell (§8.5 resize contract).
  useEffect(() => {
    const term = termRef.current;
    if (term === null || activePty === null) return;
    resizeTerminal(activePty, term.cols, term.rows);
    term.focus();
  }, [activePty, resizeTerminal]);

  const active = terminals.find((t) => t.ptyId === activePty) ?? null;
  const accrued = accruedCostLabel(machine);

  const shellSection = (
    <div
      className={cn(
        "relative flex min-h-0 flex-col",
        editorOpen ? "shrink-0 border-t border-hairline" : "min-h-0 flex-1",
      )}
      style={editorOpen ? { height: terminalHeight } : undefined}
    >
      {editorOpen ? (
        <IdeResizeHandle
          orientation="horizontal"
          value={terminalHeight}
          min={TERMINAL_MIN_HEIGHT}
          max={TERMINAL_MAX_HEIGHT}
          defaultValue={TERMINAL_DEFAULT_HEIGHT}
          ariaLabel="Resize terminal"
          compute={(_x, y) =>
            (mainColRef.current?.getBoundingClientRect().bottom ?? y) - y
          }
          onChange={setIdeTerminalHeight}
        />
      ) : null}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-hairline px-3 py-2">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {terminals.map((t) => (
            <div
              key={t.ptyId}
              className={cn(
                "flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1 text-[12px]",
                t.ptyId === activePty
                  ? "bg-ink/10 text-text"
                  : "text-muted hover:bg-ink/5",
              )}
            >
              <button
                type="button"
                onClick={() => selectPty(t.ptyId)}
                className="cursor-pointer"
                title={t.cwd}
              >
                {t.jobMode ? <span className="mr-1 text-ok">●</span> : null}
                {t.title}
                {t.exited ? (
                  <span className="ml-1 text-faint">(exited)</span>
                ) : null}
              </button>
              <button
                type="button"
                aria-label={`Close ${t.title}`}
                onClick={() => {
                  void closeTerminal(t.ptyId);
                  if (activePty === t.ptyId) setActivePty(null);
                }}
                className="grid size-3.5 cursor-pointer place-items-center rounded text-faint hover:bg-ink/12 hover:text-text"
              >
                <X className="size-2.5" aria-hidden="true" />
              </button>
            </div>
          ))}
          <button
            type="button"
            aria-label="New shell"
            title="New shell"
            onClick={() =>
              void createTerminal().then((t) => {
                if (t !== undefined) selectPty(t.ptyId);
              })
            }
            className="grid size-6 shrink-0 cursor-pointer place-items-center rounded-md text-muted hover:bg-ink/8 hover:text-text"
          >
            <Plus className="size-3" aria-hidden="true" />
          </button>
        </div>

        {active !== null ? (
          <label
            className="flex shrink-0 cursor-pointer items-center gap-1.5 text-[11px] text-muted"
            title="Job Mode (§8.5): keeps the machine awake for unattended work, with the cost visible."
          >
            <button
              type="button"
              role="switch"
              aria-checked={active.jobMode}
              aria-label="Job Mode"
              onClick={() => void setJobMode(active.ptyId, !active.jobMode)}
              className={cn(
                "relative h-[16px] w-[28px] cursor-pointer rounded-full transition-colors",
                active.jobMode ? "bg-ok" : "bg-ink/12",
              )}
            >
              <span
                className={cn(
                  "absolute top-[2px] size-[12px] rounded-full bg-white shadow transition-all",
                  active.jobMode ? "left-[14px]" : "left-[2px]",
                )}
              />
            </button>
            <span>{jobModeLabel(machine)}</span>
            {accrued.length > 0 ? (
              <span className="text-faint">· {accrued}</span>
            ) : null}
          </label>
        ) : null}
      </div>

      {active?.restore === "reconstructed" ? (
        <div className="flex shrink-0 items-center gap-2 bg-warn/12 px-4 py-1.5 text-[11.5px] font-medium text-warn">
          <span
            className="size-[6px] rounded-full"
            style={{ background: "var(--color-warn)" }}
          />
          {RECONSTRUCTED_BANNER}
        </div>
      ) : null}

      {/* No Escape handler: there is no dialog above this to dismiss, so the
          key reaches xterm — and the shell — on its own. */}
      <div className="relative min-h-0 flex-1 cursor-text bg-bg px-3 py-2">
        <div ref={setHostEl} className="h-full w-full" />
        {active === null ? (
          <p className="absolute inset-0 p-4 text-[12px] text-faint">
            No shell — open one with the + button.
          </p>
        ) : null}
      </div>
    </div>
  );

  return (
    // absolute inset-0: the pane this page fills is positioned by
    // ContentPanes, and the hole under it is transparent — hence its own
    // opaque surface, exactly like suma://settings.
    <div className="absolute inset-0 flex flex-col bg-panel text-text">
      {/* Toolbar: the page's mark plus the three panel switches. The tab strip
          names the page "Terminal"; this row is what makes it read as an IDE. */}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-hairline px-3 py-1.5">
        <TerminalIcon
          className="size-3.5 shrink-0 text-faint"
          aria-hidden="true"
        />
        <span className="flex-1" />
        <PanelToggle
          icon={PanelLeft}
          label="File explorer"
          open={explorerOpen}
          onClick={() => toggleIdePanel("explorer")}
        />
        <PanelToggle
          icon={FileCode}
          label="Editor"
          open={editorOpen}
          onClick={() => toggleIdePanel("editor")}
        />
        <PanelToggle
          icon={SquareTerminal}
          label="Terminal panel"
          open={terminalOpen}
          onClick={() => toggleIdePanel("terminal")}
        />
      </div>

      <div ref={middleRowRef} className="flex min-h-0 flex-1">
        {explorerOpen ? (
          <div
            className="relative shrink-0 border-r border-hairline"
            style={{ width: explorerWidth }}
          >
            <IdeExplorer />
            <IdeResizeHandle
              orientation="vertical"
              value={explorerWidth}
              min={EXPLORER_MIN_WIDTH}
              max={EXPLORER_MAX_WIDTH}
              defaultValue={EXPLORER_DEFAULT_WIDTH}
              ariaLabel="Resize file explorer"
              compute={(x) =>
                x - (middleRowRef.current?.getBoundingClientRect().left ?? 0)
              }
              onChange={setIdeExplorerWidth}
            />
          </div>
        ) : null}

        <div ref={mainColRef} className="flex min-w-0 flex-1 flex-col">
          {editorOpen ? (
            <div className="min-h-0 flex-1">
              <IdeEditor />
            </div>
          ) : null}
          {terminalOpen ? shellSection : null}
          {!editorOpen && !terminalOpen ? (
            <p className="p-4 text-[12px] text-faint">
              Everything is hidden — reopen the editor or terminal from the
              toolbar above.
            </p>
          ) : null}
        </div>
      </div>

      {/* Capped and scrollable, unlike the modal footer this replaces: at page
          size the chips are the same two-line strip, but a machine with two
          dozen listeners wraps them into six rows that would eat a third of
          the shell. The terminal keeps the space; the ports scroll. */}
      <div className="max-h-[72px] shrink-0 overflow-y-auto border-t border-hairline px-3 py-2">
        <PortChips />
      </div>
    </div>
  );
}

function PanelToggle({
  icon: Icon,
  label,
  open,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  open: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={open}
      title={`${open ? "Hide" : "Show"} ${label.toLowerCase()}`}
      onClick={onClick}
      className={cn(
        "grid size-6 shrink-0 cursor-pointer place-items-center rounded-md",
        open ? "bg-ink/10 text-text" : "text-muted hover:bg-ink/8 hover:text-text",
      )}
    >
      <Icon className="size-3.5" aria-hidden="true" />
    </button>
  );
}
