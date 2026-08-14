import { useEffect, useState } from "react";
import type { EgressDecisionInfo } from "../../../shared/ipc";
import { cn } from "../lib/cn";
import { selectActiveSpace, useSumaStore } from "../store";
import { MODE_BLURB, MODE_LABEL, modeColor } from "./ContinuityDot";
import { Checkbox } from "./ui/checkbox";
import { RadioGroup, RadioGroupItem } from "./ui/radio-group";

const OVERRIDE_OPTIONS: Array<{ value: "sync" | "never" | null; label: string; hint: string }> = [
  { value: null, label: "Default", hint: "Follow the tested-corpus policy for this origin" },
  { value: "sync", label: "Sync across devices", hint: "Session state follows you to every Mac" },
  { value: "never", label: "Never sync", hint: "Session stays on this Mac only" },
];

/**
 * Trust controls popover (PRD §8.7): continuity mode, sync override radio,
 * and per-origin session rollback with inline confirm.
 */
export function OriginControls() {
  const anchor = useSumaStore((s) => s.originPopover);
  const close = useSumaStore((s) => s.closeOriginControls);
  const info = useSumaStore((s) => (anchor !== null ? s.originInfo[anchor.host] : undefined));
  const setOriginOverride = useSumaStore((s) => s.setOriginOverride);
  const rollbackOrigin = useSumaStore((s) => s.rollbackOrigin);
  const activeSpace = useSumaStore(selectActiveSpace);
  const egressStatus = useSumaStore((s) =>
    activeSpace === null ? undefined : s.egressBySpace[activeSpace.id],
  );
  const explainEgress = useSumaStore((s) => s.explainEgress);
  const setSiteBypass = useSumaStore((s) => s.setSiteBypass);
  const openSettings = useSumaStore((s) => s.openSettings);
  const [confirmingRollback, setConfirmingRollback] = useState(false);
  const [egressInfo, setEgressInfo] = useState<EgressDecisionInfo | null>(null);

  useEffect(() => setConfirmingRollback(false), [anchor]);

  // §8.7: the routing decision for this origin, explained in the popover.
  const spaceId = activeSpace?.id ?? null;
  const host = anchor?.host ?? null;
  useEffect(() => {
    setEgressInfo(null);
    if (host === null || spaceId === null) return;
    let cancelled = false;
    void explainEgress(spaceId, host).then((decision) => {
      if (!cancelled && decision !== undefined) setEgressInfo(decision);
    });
    return () => {
      cancelled = true;
    };
  }, [host, spaceId, explainEgress]);

  if (anchor === null) return null;
  const top = Math.min(Math.max(anchor.y + 6, 52), window.innerHeight - 360);

  return (
    <>
      <div className="fixed inset-0 z-30" onClick={close} aria-hidden="true" />
      <div
        role="dialog"
        aria-label={`Trust controls for ${anchor.host}`}
        className="animate-overlay-in fixed left-2 z-40 w-[300px] rounded-xl border border-float-edge bg-raised p-3 shadow-pop"
        style={{ top }}
      >
        {info === undefined ? (
          <p className="py-4 text-center text-[12px] text-muted">Loading origin policy…</p>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <span
                className="size-2 shrink-0 rounded-full"
                style={{ background: modeColor(info), boxShadow: `0 0 6px ${modeColor(info)}` }}
              />
              <div className="min-w-0">
                <p className="truncate text-[13px] font-semibold">{info.label}</p>
                <p className="truncate font-mono text-[10px] text-faint">{anchor.host}</p>
              </div>
              <span className="ml-auto shrink-0 rounded-full bg-ink/6 px-2 py-0.5 text-[10px] font-medium text-muted">
                {MODE_LABEL[info.mode]}
              </span>
            </div>

            <p className="mt-2 text-[11px] leading-snug text-muted">
              {MODE_BLURB[info.mode]}. Sync tier {info.syncTier}
              {info.syncTier === 0 ? " — nothing synced silently." : "."}
            </p>

            {info.sensitive ? (
              <p className="mt-2 rounded-lg bg-warn/10 px-2.5 py-1.5 text-[11px] leading-snug text-warn">
                Sensitive origin — excluded from sync unless you opt in here.
              </p>
            ) : null}

            {info.rotatingAuth ? (
              <p className="mt-2 rounded-lg bg-ink/4 px-2.5 py-1.5 text-[11px] leading-snug text-muted">
                This site rotates auth tokens. Suma automatically moves its short-lived writer
                lease when this Mac receives the next session rotation, keeping every Mac synced.
              </p>
            ) : null}

            <fieldset className="mt-3">
              <legend className="mb-1.5 text-[10px] font-semibold tracking-[0.08em] text-faint uppercase">
                Session sync
              </legend>
              <RadioGroup
                name="origin-override"
                className="flex flex-col gap-1"
                value={info.userOverride}
                onValueChange={(next: "sync" | "never" | null) =>
                  void setOriginOverride(anchor.host, next)
                }
              >
                {OVERRIDE_OPTIONS.map((opt) => {
                  const selected = info.userOverride === opt.value;
                  return (
                    <label
                      key={opt.label}
                      title={opt.hint}
                      className={cn(
                        "flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-[12px]",
                        selected ? "bg-accent/15 text-text" : "text-muted hover:bg-ink/5",
                      )}
                    >
                      <RadioGroupItem value={opt.value} />
                      {opt.label}
                    </label>
                  );
                })}
              </RadioGroup>
            </fieldset>

            <div className="mt-3 border-t border-hairline pt-2.5">
              {confirmingRollback ? (
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      void rollbackOrigin(anchor.host);
                      close();
                    }}
                    className="flex-1 rounded-lg bg-danger/20 px-2 py-1.5 text-[12px] font-medium text-danger hover:bg-danger/30"
                  >
                    Confirm rollback
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmingRollback(false)}
                    className="rounded-lg bg-ink/6 px-2 py-1.5 text-[12px] text-muted hover:bg-ink/10"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmingRollback(true)}
                  className="w-full rounded-lg bg-ink/4 px-2 py-1.5 text-left text-[12px] text-muted hover:bg-ink/8 hover:text-text"
                >
                  Roll back this site&apos;s session…
                </button>
              )}
              <p className="mt-1.5 text-[10px] leading-snug text-faint">
                Restores the last-known-good session for this origin on this space — recoverable
                without touching the rest of your jar.
              </p>
            </div>

            {egressInfo !== null && spaceId !== null ? (
              <div className="mt-3 border-t border-hairline pt-2.5">
                <p className="mb-1.5 text-[10px] font-semibold tracking-[0.08em] text-faint uppercase">
                  Egress
                </p>
                <p className="flex items-center gap-1.5 text-[11px] leading-snug text-muted">
                  <span
                    className="size-[6px] shrink-0 rounded-full"
                    style={{
                      background:
                        egressInfo.route === "gateway"
                          ? "var(--color-ok)"
                          : egressInfo.route === "blocked"
                            ? "var(--color-danger)"
                            : "var(--color-faint)",
                    }}
                  />
                  {egressInfo.explanation}
                </p>
                {egressStatus?.policy === "suma-ip" ? (
                  <label className="mt-1.5 flex cursor-pointer items-center gap-2 text-[11px] text-muted">
                    <Checkbox
                      checked={egressStatus.siteBypass.includes(egressInfo.host)}
                      onCheckedChange={(checked) =>
                        void setSiteBypass(spaceId, egressInfo.host, checked)
                      }
                    />
                    Browse this site direct (bypass the identity IP)
                  </label>
                ) : null}
                <button
                  type="button"
                  onClick={() => {
                    close();
                    void openSettings("privacy/egress");
                  }}
                  className="mt-1.5 cursor-pointer text-[10.5px] text-accent hover:underline"
                >
                  Egress settings…
                </button>
              </div>
            ) : null}
          </>
        )}
      </div>
    </>
  );
}
