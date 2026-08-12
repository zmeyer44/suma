import { selectActiveSpace, useSumaStore } from "../store";

/**
 * The §8.4 fail-closed surface: a banner when the active space's gateway
 * path is down (with the one-click, non-sticky "browse direct for now").
 * The challenge-triggered per-site bypass SUGGESTIONS are the separate
 * BypassSuggestions component in App's bottom-left notification stack —
 * Suma never moves a site off the identity IP silently, so those cards
 * must render where the tab views cannot cover them.
 */
export function EgressBanner() {
  const activeSpace = useSumaStore(selectActiveSpace);
  const status = useSumaStore((s) =>
    activeSpace === null ? undefined : s.egressBySpace[activeSpace.id],
  );
  const browseDirectForNow = useSumaStore((s) => s.browseDirectForNow);

  const failClosed = status !== undefined && status.failClosed;
  // Configured for the identity IP but not routed this run — the user must
  // know they are browsing direct rather than assume they are protected.
  const restartRequired = status !== undefined && status.restartRequired;

  return (
    <>
      {restartRequired && activeSpace !== null ? (
        <div className="flex h-8 shrink-0 items-center justify-center gap-3 bg-warn/15 px-4 text-[11.5px] font-medium text-warn">
          <span className="size-[6px] rounded-full" style={{ background: "var(--color-warn)" }} />
          {activeSpace.name} is set to use your Suma identity IP, but is browsing direct until you
          restart Suma — routing it now would leak your real IP over QUIC.
        </div>
      ) : null}

      {failClosed && activeSpace !== null ? (
        <div className="flex h-8 shrink-0 items-center justify-center gap-3 bg-danger/15 px-4 text-[11.5px] font-medium text-danger">
          <span
            className="size-[6px] rounded-full"
            style={{ background: "var(--color-danger)", boxShadow: "0 0 5px var(--color-danger)" }}
          />
          Identity gateway unreachable. Suma blocked these requests rather than reveal your real
          IP.
          <button
            type="button"
            onClick={() => void browseDirectForNow(activeSpace.id)}
            className="cursor-pointer rounded-md bg-danger/20 px-2 py-0.5 font-semibold hover:bg-danger/30"
          >
            Browse direct for now
          </button>
        </div>
      ) : null}

    </>
  );
}

/** §8.4 per-site bypass suggestion cards — rendered in App's bottom-left
 *  notification stack, never silently applied. */
export function BypassSuggestions() {
  const suggestions = useSumaStore((s) => s.bypassSuggestions);
  const spaces = useSumaStore((s) => s.spaces);
  const setSiteBypass = useSumaStore((s) => s.setSiteBypass);
  const dismissBypassSuggestion = useSumaStore((s) => s.dismissBypassSuggestion);

  if (suggestions.length === 0) return null;
  return (
    <>
      {suggestions.map((s) => {
        const spaceName = spaces.find((sp) => sp.id === s.spaceId)?.name ?? "this space";
        return (
          <div
            key={`${s.spaceId}|${s.host}`}
            className="animate-toast-in pointer-events-auto w-full rounded-lg border border-hairline bg-raised p-3 shadow-pop"
          >
            <p className="text-[12px] leading-snug text-text">
              <span className="font-mono">{s.host}</span> may be challenging your identity IP.
            </p>
            <p className="mt-1 text-[11px] leading-snug text-faint">{s.reason}</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void setSiteBypass(s.spaceId, s.host, true)}
                className="cursor-pointer rounded-md bg-accent/15 px-2 py-1 text-[11px] font-medium text-accent hover:bg-accent/25"
              >
                Browse {s.host} direct in {spaceName}
              </button>
              <button
                type="button"
                onClick={() => dismissBypassSuggestion(s.spaceId, s.host)}
                className="cursor-pointer rounded-md bg-ink/6 px-2 py-1 text-[11px] text-muted hover:bg-ink/10"
              >
                Keep identity IP
              </button>
            </div>
          </div>
        );
      })}
    </>
  );
}
