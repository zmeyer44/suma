import { useEffect } from "react";
import { Shield } from "lucide-react";
import type { ContinuityMode } from "@suma/protocol";
import type { OriginContinuityInfo } from "../../../shared/ipc";
import { useSumaStore } from "../store";

export const MODE_LABEL: Record<ContinuityMode, string> = {
  portable: "Portable",
  assisted: "Assisted",
  device_bound: "Device-bound",
};

export const MODE_BLURB: Record<ContinuityMode, string> = {
  portable: "Session syncs across your Macs",
  assisted: "One-touch sign-in on new devices",
  device_bound: "This site binds sessions to a device",
};

export function modeColor(info: OriginContinuityInfo): string {
  if (info.sensitive) return "var(--color-muted)";
  switch (info.mode) {
    case "portable":
      return "var(--color-ok)";
    case "assisted":
      return "var(--color-warn)";
    case "device_bound":
      return "var(--color-faint)";
  }
}

function overrideLabel(info: OriginContinuityInfo): string {
  if (info.userOverride === "sync") return "override: always sync";
  if (info.userOverride === "never") return "override: never sync";
  return "corpus default";
}


/**
 * Per-tab origin continuity indicator (PRD §4): green portable, amber
 * assisted, gray device-bound, shield for sensitive/excluded origins.
 * Click opens the OriginControls popover.
 */
export function ContinuityDot({ host }: { host: string }) {
  const info = useSumaStore((s) => s.originInfo[host]);
  const fetchOriginInfo = useSumaStore((s) => s.fetchOriginInfo);
  const openOriginControls = useSumaStore((s) => s.openOriginControls);

  useEffect(() => {
    if (host.length > 0 && info === undefined) void fetchOriginInfo(host);
  }, [host, info, fetchOriginInfo]);

  if (host.length === 0) return <span className="size-4 shrink-0" />;

  const tooltip =
    info === undefined
      ? host
      : [
          `${info.label} · ${MODE_LABEL[info.mode]}`,
          MODE_BLURB[info.mode],
          `Sync tier ${info.syncTier} · ${overrideLabel(info)}`,
          info.sensitive ? "Sensitive — excluded from sync" : null,
        ]
          .filter((l): l is string => l !== null)
          .join("\n");

  return (
    <button
      type="button"
      title={tooltip}
      aria-label={`Continuity for ${host}`}
      onClick={(e) => {
        e.stopPropagation();
        const rect = e.currentTarget.getBoundingClientRect();
        openOriginControls({ host, x: rect.left, y: rect.bottom });
      }}
      className="grid size-4 shrink-0 cursor-pointer place-items-center rounded-full hover:bg-ink/10"
    >
      {info === undefined ? (
        <span className="size-[7px] rounded-full border border-ink/25" />
      ) : info.sensitive ? (
        <Shield
          className="size-[11px]"
          fill={modeColor(info)}
          fillOpacity={0.9}
          stroke="none"
          aria-hidden="true"
        />
      ) : (
        <span
          className="size-[7px] rounded-full"
          style={{ background: modeColor(info), boxShadow: `0 0 6px ${modeColor(info)}` }}
        />
      )}
    </button>
  );
}
