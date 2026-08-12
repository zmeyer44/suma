import { useState } from "react";
import type { PlaneHealth, SyncStatus } from "../../../shared/ipc";
import { cn } from "../lib/cn";
import { accruedCostLabel, machinePillText, machineTone } from "../lib/compute";
import { selectActiveSpace, useSumaStore } from "../store";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "./ui/hover-card";

function syncPill(status: SyncStatus): { text: string; color: string; pulse: boolean } {
  const depth = status.queueDepth > 0 ? ` · ${status.queueDepth} queued` : "";
  switch (status.state) {
    case "connected":
      return { text: "Synced", color: "var(--color-ok)", pulse: false };
    case "connecting":
      return { text: `Connecting…${depth}`, color: "var(--color-warn)", pulse: true };
    case "offline":
      return { text: `Offline${depth}`, color: "var(--color-faint)", pulse: false };
    case "paused":
      return { text: `Sync paused${depth}`, color: "var(--color-warn)", pulse: true };
  }
}

function agoLabel(ms: number | null): string {
  if (ms === null) return "never converged";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 5) return "converged just now";
  if (s < 60) return `converged ${s}s ago`;
  if (s < 3600) return `converged ${Math.round(s / 60)}m ago`;
  return `converged ${Math.round(s / 3600)}h ago`;
}

function StatusDot({ color, pulse }: { color: string; pulse?: boolean }) {
  return (
    <span
      className={cn("inline-block size-[6px] shrink-0 rounded-full", pulse === true && "animate-pulse-dot")}
      style={{ background: color, boxShadow: `0 0 5px ${color}` }}
    />
  );
}

/** One status entry inside the hover card: dot, label, and its full explanation. */
function StatusRow({
  color,
  pulse,
  label,
  detail,
  children,
}: {
  color: string;
  pulse?: boolean;
  label: string;
  detail: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex gap-2.5">
      <span className="mt-[5px]">
        <StatusDot color={color} pulse={pulse} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[12px] font-medium text-text">{label}</p>
        <p className="mt-0.5 text-[11px] leading-snug text-muted">{detail}</p>
        {children}
      </div>
    </div>
  );
}

const TONE_COLOR: Record<string, string> = {
  ok: "var(--color-ok)",
  warn: "var(--color-warn)",
  danger: "var(--color-danger)",
  faint: "var(--color-faint)",
};

/** The §8.5 machine section: state, the lifecycle's why, the visible cost meter, and wake/suspend. */
function MachineSection({ onClose }: { onClose: () => void }) {
  const machine = useSumaStore((s) => s.machine);
  const wakeMachine = useSumaStore((s) => s.wakeMachine);
  const suspendMachine = useSumaStore((s) => s.suspendMachine);
  const openTerminal = useSumaStore((s) => s.openTerminal);

  const pulse =
    machine !== null &&
    ["resuming", "cold_booting", "boosting", "suspending", "shrinking", "provisioning"].includes(
      machine.state,
    );
  const accrued = machine === null ? "" : accruedCostLabel(machine);

  return (
    <StatusRow
      color={TONE_COLOR[machineTone(machine)] ?? "var(--color-faint)"}
      pulse={pulse}
      label={machinePillText(machine)}
      detail={machine?.reason ?? "Machine status unavailable"}
    >
      {machine !== null && machine.machineId !== null ? (
        <p className="mt-1 text-[11px] text-muted">
          {machine.spec.cpus} vCPU · {Math.round(machine.spec.memoryMb / 1024)} GB · {machine.hourlyRate}
        </p>
      ) : null}
      {accrued.length > 0 ? <p className="mt-0.5 text-[11px] text-faint">{accrued}</p> : null}
      {machine !== null ? (
        <div className="mt-2 flex items-center gap-2">
          {machine.machineId !== null && machine.state === "suspended" ? (
            <button
              type="button"
              onClick={() => void wakeMachine()}
              className="cursor-pointer rounded-md bg-accent/15 px-2 py-1 text-[11px] font-medium text-accent hover:bg-accent/25"
            >
              Wake
            </button>
          ) : null}
          {machine.machineId !== null && (machine.state === "running" || machine.state === "boosted") ? (
            <button
              type="button"
              onClick={() => void suspendMachine()}
              className="cursor-pointer rounded-md bg-ink/8 px-2 py-1 text-[11px] font-medium text-muted hover:bg-ink/12"
            >
              Suspend
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => {
              onClose();
              void openTerminal();
            }}
            className="cursor-pointer rounded-md bg-ink/8 px-2 py-1 text-[11px] font-medium text-muted hover:bg-ink/12"
          >
            Terminal
          </button>
        </div>
      ) : null}
    </StatusRow>
  );
}

/**
 * Top-bar status cluster, collapsed into a single trigger: three dots (sync
 * state, key mode §8.2, machine §8.5) that reveal a hover card with the full
 * stories. The card's own open state is local; the store flag is the separate
 * question of whether the chrome view must be raised above the tab views,
 * which it must for as long as the popup overhangs the content hole — through
 * the close animation, not just until closing starts.
 */
export function StatusPills() {
  const syncStatus = useSumaStore((s) => s.syncStatus);
  const auth = useSumaStore((s) => s.auth);
  const machine = useSumaStore((s) => s.machine);
  const [open, setOpen] = useState(false);
  const setChromeRaised = useSumaStore((s) => s.setStatusPopoverOpen);
  const refreshMachine = useSumaStore((s) => s.refreshMachine);

  const sync = syncPill(syncStatus);
  const e2ee = syncStatus.keyMode === "e2ee";
  const enrolled = auth.state === "enrolled" && auth.passkeyRegistered;
  const keyColor = e2ee ? "var(--color-ok)" : "var(--color-warn)";

  const keyPill = !e2ee
    ? {
        text: "Suma-managed keys",
        title: "Suma-managed keys — a visible security mode, never a silent downgrade",
      }
    : enrolled
      ? {
          text: "E2EE",
          title: `End-to-end encrypted — keys wrapped by your ${
            auth.credentialKind === "webauthn" ? "passkey" : "device credential"
          }; only enrolled devices hold them`,
        }
      : {
          text: "E2EE · this Mac",
          title: "End-to-end encrypted — keys exist only on this Mac. Set up Suma to enroll more devices.",
        };

  return (
    <HoverCard
      open={open}
      onOpenChange={(next) => {
        if (next) {
          void refreshMachine();
          setChromeRaised(true);
        }
        setOpen(next);
      }}
      onOpenChangeComplete={(nowOpen) => {
        if (!nowOpen) setChromeRaised(false);
      }}
    >
      <HoverCardTrigger
        render={<button type="button" />}
        title="Workspace status"
        aria-label="Workspace status"
        className="flex shrink-0 items-center gap-[5px] rounded-full bg-ink/5 px-2.5 py-[7px] hover:bg-ink/8"
      >
        <StatusDot color={sync.color} pulse={sync.pulse} />
        <StatusDot color={keyColor} />
        <StatusDot color={TONE_COLOR[machineTone(machine)] ?? "var(--color-faint)"} />
      </HoverCardTrigger>
      <HoverCardContent align="end" sideOffset={8} className="flex flex-col gap-3">
        <StatusRow
          color={sync.color}
          pulse={sync.pulse}
          label={sync.text}
          detail={`Session plane: ${syncStatus.state} · ${agoLabel(syncStatus.lastConvergedMs)}`}
        />
        <StatusRow color={keyColor} label={keyPill.text} detail={keyPill.title} />
        <MachineSection onClose={() => setOpen(false)} />
      </HoverCardContent>
    </HoverCard>
  );
}

function bannerMessages(health: PlaneHealth): Array<{ key: string; text: string; tone: "warn" | "danger" }> {
  const out: Array<{ key: string; text: string; tone: "warn" | "danger" }> = [];
  if (health.sessionPlane !== "ok") {
    out.push({
      key: "session",
      text: "Sync paused — browsing continues with local state",
      tone: "warn",
    });
  }
  if (health.egressPlane === "down" || health.egressPlane === "degraded") {
    out.push({
      key: "egress",
      text: "Identity egress unreachable — failing closed. Switch a space to browse direct in Settings.",
      tone: "danger",
    });
  } else if (health.egressPlane === "bypassed") {
    out.push({ key: "egress", text: "Browsing direct on this network — identity IP bypassed", tone: "warn" });
  }
  if (health.computePlane === "cold_booted") {
    out.push({
      key: "compute",
      text: "Terminal restored from cold start — running processes were not recovered",
      tone: "warn",
    });
  } else if (health.computePlane !== "ok") {
    out.push({
      key: "compute",
      text: "Compute plane unavailable — terminal and cloud fetch are offline",
      tone: "warn",
    });
  }
  return out;
}

/** Full-width degraded-mode strip (§10 failure-mode matrix) rendered above the shell. */
export function DegradedBanner() {
  const health = useSumaStore((s) => s.health);
  const activeSpace = useSumaStore(selectActiveSpace);
  const activeEgressFailClosed = useSumaStore((s) =>
    activeSpace === null ? false : s.egressBySpace[activeSpace.id]?.failClosed === true,
  );
  // When the actionable §8.4 fail-closed banner (EgressBanner) is showing for
  // the active space, the generic egress line would be a duplicate — drop it.
  const messages = bannerMessages(health).filter(
    (m) => !(m.key === "egress" && activeEgressFailClosed),
  );
  if (messages.length === 0) return null;

  return (
    <div className="flex shrink-0 flex-col">
      {messages.map((m) => (
        <div
          key={m.key}
          className={cn(
            "flex h-7 items-center justify-center gap-2 px-4 text-[11.5px] font-medium",
            m.tone === "danger" ? "bg-danger/15 text-danger" : "bg-warn/12 text-warn",
          )}
        >
          <span
            className="size-[6px] rounded-full"
            style={{
              background: m.tone === "danger" ? "var(--color-danger)" : "var(--color-warn)",
              boxShadow: `0 0 5px ${m.tone === "danger" ? "var(--color-danger)" : "var(--color-warn)"}`,
            }}
          />
          {m.text}
        </div>
      ))}
    </div>
  );
}
