import { useState } from "react";
import type { LucideIcon } from "lucide-react";
import { Cloud, Download, Link2, Merge, Monitor, Upload } from "lucide-react";
import type {
  WorkspaceSyncMode,
  WorkspaceSyncSource,
} from "../../../shared/ipc";
import { cn } from "../lib/cn";
import { useSumaStore } from "../store";
import { Modal, ModalContent, ModalFooter } from "./ui/modal";

const ACTIONS: ReadonlyArray<{
  mode: WorkspaceSyncMode;
  title: string;
  eyebrow: string;
  tone: string;
  icon: LucideIcon;
}> = [
  {
    mode: "merge",
    title: "Merge",
    eyebrow: "Keep both",
    tone: "border-ok/25 bg-ok/[0.055] hover:border-ok/45 hover:bg-ok/[0.09]",
    icon: Merge,
  },
  {
    mode: "pull",
    title: "Pull",
    eyebrow: "Use source",
    tone: "border-accent/20 bg-accent/[0.045] hover:border-accent/40 hover:bg-accent/[0.08]",
    icon: Download,
  },
  {
    mode: "push",
    title: "Push",
    eyebrow: "Make canonical",
    tone: "border-warn/20 bg-warn/[0.045] hover:border-warn/40 hover:bg-warn/[0.08]",
    icon: Upload,
  },
];

function relativeSavedTime(updatedAtMs: number): string {
  const elapsed = Math.max(0, Date.now() - updatedAtMs);
  if (elapsed < 60_000) return "Saved just now";
  if (elapsed < 3_600_000) return `Saved ${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000)
    return `Saved ${Math.floor(elapsed / 3_600_000)}h ago`;
  return `Saved ${Math.floor(elapsed / 86_400_000)}d ago`;
}

function actionDescription(
  mode: WorkspaceSyncMode,
  source: WorkspaceSyncSource | undefined,
): string {
  if (source !== undefined) {
    return mode === "merge"
      ? `Add tabs unique to this Mac to ${source.name}’s saved workspace.`
      : `Replace this Mac’s tabs and focus with ${source.name}’s saved workspace.`;
  }
  if (mode === "merge")
    return "Keep canonical tabs and sessions, then add tabs unique to this Mac.";
  if (mode === "pull")
    return "Replace this Mac with the canonical workspace and account sessions.";
  return "Make this Mac’s workspace and sessions canonical for future syncs.";
}

export function WorkspaceSyncDialog() {
  const open = useSumaStore((s) => s.overlay === "workspace-sync");
  const setOverlay = useSumaStore((s) => s.setOverlay);
  const remoteReady = useSumaStore((s) => s.workspaceSync.remoteReady);
  const canonicalPending = useSumaStore(
    (s) => s.workspaceSync.canonicalPending,
  );
  const localChanged = useSumaStore((s) => s.workspaceSync.localChanged);
  const remoteChanged = useSumaStore((s) => s.workspaceSync.remoteChanged);
  const sources = useSumaStore((s) => s.workspaceSync.sources);
  const devices = useSumaStore((s) => s.devices);
  const syncWorkspace = useSumaStore((s) => s.syncWorkspace);
  const [sourceDeviceId, setSourceDeviceId] = useState<string | null>(null);
  const [busy, setBusy] = useState<WorkspaceSyncMode | null>(null);

  const selectedSource = sources.find(
    (source) => source.deviceId === sourceDeviceId,
  );
  const selectedDeviceId = selectedSource?.deviceId;
  const canonicalSelected = selectedSource === undefined;
  const sourceReady = canonicalSelected ? canonicalPending : true;
  const availableActions = canonicalSelected
    ? ACTIONS
    : ACTIONS.filter((action) => action.mode !== "push");

  const choose = async (mode: WorkspaceSyncMode) => {
    if (busy !== null || !remoteReady || !sourceReady) return;
    setBusy(mode);
    try {
      await syncWorkspace(mode, selectedDeviceId);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!next && busy === null) setOverlay("none");
      }}
    >
      <ModalContent
        title="Sync workspace"
        width={560}
        icon={
          <Link2 className="size-3.5" aria-hidden="true" />
        }
        badge={
          <span className="rounded bg-accent/12 px-1.5 py-px text-[8.5px] font-semibold tracking-wide text-accent uppercase">
            Changes ready
          </span>
        }
      >
        <div className="px-4 pt-3 pb-4">
          <p className="max-w-[500px] text-[12px] leading-relaxed text-muted">
            Choose the exact restore point you want. Each Mac saves its own
            workspace automatically; only an explicit sync changes canonical.
          </p>

          <div className="mt-2 flex gap-1.5 text-[9.5px] text-faint">
            {remoteChanged ? (
              <span className="rounded-full bg-accent/8 px-2 py-0.5">
                Shared changes
              </span>
            ) : null}
            {localChanged ? (
              <span className="rounded-full bg-ink/6 px-2 py-0.5">
                Changes on this Mac
              </span>
            ) : null}
            {sources.length > 0 ? (
              <span className="rounded-full bg-ok/10 px-2 py-0.5 text-ok">
                {sources.length} device{" "}
                {sources.length === 1 ? "copy" : "copies"}
              </span>
            ) : null}
          </div>

          <div
            className="mt-3 rounded-xl border border-ink/8 bg-ink/[0.018] p-1.5"
            data-testid="workspace-sync-sources"
          >
            <p className="px-2 pt-1 pb-1.5 text-[9px] font-semibold tracking-[0.12em] text-faint uppercase">
              Sync with
            </p>
            <div className="grid gap-1">
              <button
                type="button"
                onClick={() => setSourceDeviceId(null)}
                data-testid="workspace-sync-source-canonical"
                className={cn(
                  "flex cursor-pointer items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left transition-colors",
                  canonicalSelected
                    ? "border-accent/30 bg-surface shadow-sm"
                    : "border-transparent hover:bg-surface/70",
                )}
              >
                <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-accent/10 text-accent">
                  <Cloud className="size-3.5" aria-hidden="true" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[11.5px] font-semibold text-text">
                    Canonical workspace
                  </span>
                  <span className="block text-[9.5px] text-faint">
                    Shared restore point · account sessions
                  </span>
                </span>
                <span
                  className={cn(
                    "rounded-full px-2 py-0.5 text-[8.5px] font-semibold",
                    canonicalPending ? "bg-accent/10 text-accent" : "bg-ink/5 text-faint",
                  )}
                >
                  {canonicalPending ? "Different" : "Matches this Mac"}
                </span>
              </button>

              {sources.map((source) => {
                const device = devices.find(
                  (candidate) =>
                    candidate.deviceId === source.deviceId ||
                    candidate.name === source.name,
                );
                const selected = selectedDeviceId === source.deviceId;
                return (
                  <button
                    key={source.deviceId}
                    type="button"
                    onClick={() => setSourceDeviceId(source.deviceId)}
                    data-testid={`workspace-sync-source-${source.deviceId}`}
                    className={cn(
                      "flex cursor-pointer items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left transition-colors",
                      selected
                        ? "border-ok/35 bg-surface shadow-sm"
                        : "border-transparent hover:bg-surface/70",
                    )}
                  >
                    <span className="relative grid size-7 shrink-0 place-items-center rounded-lg bg-ink/6 text-muted">
                      <Monitor className="size-3.5" aria-hidden="true" />
                      <span
                        className={cn(
                          "absolute right-0 bottom-0 size-1.5 rounded-full border border-surface",
                          device?.online === true ? "bg-ok" : "bg-faint",
                        )}
                      />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[11.5px] font-semibold text-text">
                        {device?.name ?? source.name}
                      </span>
                      <span className="block truncate text-[9.5px] text-faint">
                        {device?.platform ?? source.platform} ·{" "}
                        {relativeSavedTime(source.updatedAtMs)}
                      </span>
                    </span>
                    <span className="rounded-full bg-ok/10 px-2 py-0.5 text-[8.5px] font-semibold text-ok">
                      Unique copy
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div
            className={cn("mt-3 grid gap-2", canonicalSelected ? "grid-cols-3" : "grid-cols-2")}
            data-testid="workspace-sync-options"
          >
            {availableActions.map((action, index) => (
              <button
                key={action.mode}
                type="button"
                disabled={busy !== null || !remoteReady || !sourceReady}
                onClick={() => void choose(action.mode)}
                data-testid={`workspace-sync-${action.mode}`}
                className={cn(
                  "group cursor-pointer rounded-xl border px-3 py-2.5 text-left transition-[border-color,background-color,transform] duration-150 hover:-translate-y-px disabled:cursor-default disabled:transform-none disabled:opacity-40",
                  action.tone,
                )}
              >
                <span className="flex items-center gap-2">
                  <span className="grid size-7 shrink-0 place-items-center rounded-lg border border-ink/8 bg-surface/70 text-muted shadow-sm">
                    <action.icon className="size-3.5" aria-hidden="true" />
                  </span>
                  <span>
                    <span className="block text-[11.5px] font-semibold text-text">
                      {busy === action.mode ? "Syncing…" : action.title}
                    </span>
                    <span className="block text-[8.5px] font-semibold tracking-[0.08em] text-faint uppercase">
                      {action.eyebrow}
                    </span>
                  </span>
                  {index === 0 ? (
                    <span className="ml-auto rounded-full bg-ok/15 px-1.5 py-px text-[7.5px] font-semibold tracking-wide text-ok uppercase">
                      Recommended
                    </span>
                  ) : null}
                </span>
                <span className="mt-2 block text-[10px] leading-snug text-muted">
                  {actionDescription(action.mode, selectedSource)}
                </span>
              </button>
            ))}
          </div>

          {!remoteReady ? (
            <p className="mt-2 text-[10.5px] text-warn">
              Waiting for the canonical and device snapshots…
            </p>
          ) : null}
        </div>

        <ModalFooter>
          <p className="mr-auto text-[10.5px] text-faint">
            Device copies save tabs and focus. Account sessions always use
            canonical.
          </p>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => setOverlay("none")}
            className="cursor-pointer rounded-lg bg-ink/6 px-3 py-1.5 text-[11.5px] text-muted hover:bg-ink/10 hover:text-text disabled:cursor-default disabled:opacity-40"
          >
            Not now
          </button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
