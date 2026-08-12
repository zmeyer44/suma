import { hostOf } from "../lib/url";
import { ShieldAlert, X } from "lucide-react";
import { selectActiveTab, useSumaStore } from "../store";

/**
 * Fail-closed TLS banner (§8.1): shown when a blocked certificate error
 * matches the active tab's host. Deliberately offers no way to continue —
 * Phase 1 fails closed by design. Entries expire from the store on their own.
 */
export function CertErrorBanner() {
  const certErrors = useSumaStore((s) => s.certErrors);
  const activeTab = useSumaStore(selectActiveTab);
  const dismissCertError = useSumaStore((s) => s.dismissCertError);

  if (activeTab === null || certErrors.length === 0) return null;
  const activeHost = hostOf(activeTab.url);
  if (activeHost.length === 0) return null;
  const match = certErrors.find((e) => e.host === activeHost || hostOf(e.url) === activeHost);
  if (match === undefined) return null;

  return (
    <div className="flex shrink-0 items-center justify-center gap-2 bg-danger/15 px-4 py-1.5 text-[11.5px] font-medium text-danger">
      <ShieldAlert className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0 truncate">
        Suma blocked {match.host}: the site&apos;s certificate isn&apos;t valid. For your safety
        there&apos;s no way to continue.
      </span>
      <span className="shrink-0 font-mono text-[10px] font-normal text-danger/70">{match.error}</span>
      <button
        type="button"
        aria-label="Dismiss certificate warning"
        title="Hide this warning — the page stays blocked"
        onClick={() => dismissCertError(match.host, match.atMs)}
        className="grid size-5 shrink-0 cursor-pointer place-items-center rounded-md hover:bg-danger/20"
      >
        <X className="size-2.5" aria-hidden="true" />
      </button>
    </div>
  );
}
