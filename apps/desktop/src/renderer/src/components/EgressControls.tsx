import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { useSumaStore } from "../store";
import { Input } from "./ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";

const POLICY_ITEMS = [
  { value: "suma-ip", label: "Via Suma identity IP" },
  { value: "direct", label: "Browse direct" },
];

/**
 * Per-space identity-egress controls (PRD §8.4, §8.7): the identity-IP vs
 * direct toggle, gateway health, media-bypass state, and the site-bypass
 * list. Reachable from Settings and from the origin popover.
 */
export function EgressControls() {
  const spaces = useSumaStore((s) => s.spaces);
  const egressBySpace = useSumaStore((s) => s.egressBySpace);
  const refreshEgress = useSumaStore((s) => s.refreshEgress);
  const setEgressPolicy = useSumaStore((s) => s.setEgressPolicy);
  const setSiteBypass = useSumaStore((s) => s.setSiteBypass);
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  useEffect(() => {
    for (const space of spaces) void refreshEgress(space.id);
    // Refresh once per mount for the current space list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const gateway = Object.values(egressBySpace)[0]?.gateway ?? "down";

  return (
    <div>
      <p className="mb-2 text-[11px] leading-snug text-faint">
        Each space browses through your stable Suma identity IP or goes direct. When the gateway
        is unreachable, proxied spaces fail closed — never a silent fall-back to your real IP.
        High-bandwidth media domains bypass the gateway by default. QUIC is disabled at launch for
        proxied spaces (a CONNECT proxy tunnels TCP only); a newly proxied space gets that guard at
        the next launch.
      </p>
      <p className="mb-2 flex items-center gap-1.5 text-[11px] text-muted">
        <span
          className="size-[6px] rounded-full"
          style={{
            background: gateway === "up" ? "var(--color-ok)" : "var(--color-warn)",
            boxShadow: `0 0 5px ${gateway === "up" ? "var(--color-ok)" : "var(--color-warn)"}`,
          }}
        />
        Identity gateway: {gateway === "up" ? "reachable" : "unreachable — proxied spaces fail closed"}
      </p>

      {spaces.length === 0 ? (
        <p className="text-[12px] text-faint">No spaces yet.</p>
      ) : (
        spaces.map((space) => {
          const status = egressBySpace[space.id];
          const proxied = space.egressPolicy === "suma-ip";
          return (
            <div key={space.id} className="border-t border-hairline py-2 first:border-t-0">
              <div className="flex items-center gap-2.5">
                <span className="size-2.5 shrink-0 rounded-full" style={{ background: space.color }} />
                <span className="min-w-0 flex-1 truncate text-[13px]">{space.name}</span>
                {status?.temporaryDirectOverride === true ? (
                  <span
                    className="rounded-full bg-warn/12 px-2 py-0.5 text-[10px] font-medium text-warn"
                    title="Browsing direct for now — resets when the gateway comes back (§8.4)"
                  >
                    direct for now
                  </span>
                ) : null}
                <Select
                  value={space.egressPolicy}
                  items={POLICY_ITEMS}
                  onValueChange={(policy: string) =>
                    void setEgressPolicy(space.id, policy === "suma-ip" ? "suma-ip" : "direct")
                  }
                >
                  <SelectTrigger aria-label={`Egress policy for ${space.name}`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent align="end">
                    {POLICY_ITEMS.map((policy) => (
                      <SelectItem key={policy.value} value={policy.value}>
                        {policy.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {proxied ? (
                <div className="mt-1.5 ml-5">
                  <p className="text-[10.5px] text-faint">
                    Media bypass: {status?.mediaBypass === false ? "off" : "on (default)"} · site
                    bypasses browse direct:
                  </p>
                  <div className="mt-1 flex flex-wrap items-center gap-1">
                    {(status?.siteBypass ?? []).map((host) => (
                      <span
                        key={host}
                        className="flex items-center gap-1 rounded-full border border-hairline bg-ink/4 py-0.5 pr-1 pl-2 font-mono text-[10.5px] text-muted"
                      >
                        {host}
                        <button
                          type="button"
                          aria-label={`Remove bypass for ${host}`}
                          onClick={() => void setSiteBypass(space.id, host, false)}
                          className="grid size-3.5 cursor-pointer place-items-center rounded text-faint hover:bg-ink/12 hover:text-text"
                        >
                          <X className="size-2.5" aria-hidden="true" />
                        </button>
                      </span>
                    ))}
                    <Input
                      size="sm"
                      type="text"
                      spellCheck={false}
                      placeholder="add host…"
                      aria-label={`Add site bypass for ${space.name}`}
                      value={drafts[space.id] ?? ""}
                      onChange={(e) => setDrafts((d) => ({ ...d, [space.id]: e.target.value }))}
                      onKeyDown={(e) => {
                        if (e.key !== "Enter") return;
                        const host = (drafts[space.id] ?? "").trim();
                        if (host.length === 0) return;
                        void setSiteBypass(space.id, host, true);
                        setDrafts((d) => ({ ...d, [space.id]: "" }));
                      }}
                      className="w-[120px] font-mono"
                    />
                  </div>
                </div>
              ) : null}
            </div>
          );
        })
      )}
    </div>
  );
}
