import { cn } from "../lib/cn";
import { useSumaStore } from "../store";

/**
 * Port-forwarding chips (PRD §8.5): every detected listener on the machine,
 * a forward toggle, and the local URL — click opens it in a tab.
 */
export function PortChips() {
  const ports = useSumaStore((s) => s.ports);
  const setPortForward = useSumaStore((s) => s.setPortForward);
  const createTab = useSumaStore((s) => s.createTab);

  if (ports.length === 0) {
    return <p className="text-[11px] text-faint">No listening ports detected on the machine.</p>;
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-[10px] font-semibold tracking-[0.1em] text-faint uppercase">Ports</span>
      {ports.map((p) => (
        <span
          key={p.port}
          className="flex items-center gap-1.5 rounded-full border border-hairline bg-ink/4 py-0.5 pr-1 pl-2 text-[11px]"
          title={`${p.process} listening on ${p.port}`}
        >
          <span
            className="size-[6px] rounded-full"
            style={{ background: p.forwarded ? "var(--color-ok)" : "var(--color-faint)" }}
          />
          <span className="font-mono">:{p.port}</span>
          <span className="max-w-[90px] truncate text-faint">{p.process}</span>
          {p.forwarded ? (
            <button
              type="button"
              // No overlay to dismiss: the chips live on the terminal PAGE,
              // and the tab this opens is what takes the window.
              title={`Open ${p.localUrl} in a tab`}
              onClick={() => void createTab(p.localUrl)}
              className="cursor-pointer rounded-full bg-accent/15 px-1.5 py-px font-mono text-[10px] text-accent hover:bg-accent/25"
            >
              {p.localUrl.replace(/^http:\/\//, "")} ↗
            </button>
          ) : null}
          <button
            type="button"
            aria-label={`${p.forwarded ? "Stop forwarding" : "Forward"} port ${p.port}`}
            title={p.forwarded ? "Stop forwarding" : "Forward to this Mac"}
            onClick={() => void setPortForward(p.port, !p.forwarded)}
            className={cn(
              "cursor-pointer rounded-full px-1.5 py-px text-[10px] font-medium",
              p.forwarded
                ? "bg-ink/8 text-muted hover:bg-ink/12"
                : "bg-accent/15 text-accent hover:bg-accent/25",
            )}
          >
            {p.forwarded ? "Stop" : "Forward"}
          </button>
        </span>
      ))}
    </div>
  );
}
