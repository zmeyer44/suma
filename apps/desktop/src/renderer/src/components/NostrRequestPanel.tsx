/**
 * The Nostr request detail panel — the side panel an overlay approval card
 * expands into (ChatSidebar/SavesPanel's sibling on the right edge, same
 * content-hole mechanics: it takes real layout width and main resizes the
 * tab views around it).
 *
 * The overlay card answers the common case in two words; this panel is for
 * the moment the user wants to see EXACTLY what a site is asking them to
 * sign — the full event, tags and all — before an approval that cannot be
 * unsigned. Both surfaces answer through the same `nostr:respond` channel,
 * and main's queue push is what advances or closes this panel (store.ts).
 */

import { useState } from "react";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  KeyRound,
  Settings2,
  X,
} from "lucide-react";
import {
  nostrKindLabel,
  nostrRememberLabel,
  nostrRequestSummary,
  type NostrPendingRequest,
} from "../../../shared/nostr";
import { cn } from "../lib/cn";
import { useSumaStore } from "../store";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { PanelChrome } from "./PanelChrome";

const PANEL_WIDTH = 360;

/** One labeled fact about the request. */
function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] font-medium tracking-wide text-faint uppercase">
        {label}
      </span>
      <span className="min-w-0 text-[12px] break-words text-text">{children}</span>
    </div>
  );
}

function RequestDetail({ request }: { request: NostrPendingRequest }) {
  const respondNostr = useSumaStore((s) => s.respondNostr);
  const [remember, setRemember] = useState(false);
  const [rawOpen, setRawOpen] = useState(false);
  const payload = request.payload;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        <Fact label="Site">
          <span className="font-mono text-[11.5px]">{request.origin}</span>
        </Fact>
        <Fact label="Request">{nostrRequestSummary(payload)}</Fact>

        {payload.method === "signEvent" ? (
          <>
            <Fact label="Kind">
              {nostrKindLabel(payload.event.kind)}{" "}
              <span className="text-faint">({payload.event.kind})</span>
            </Fact>
            <Fact label="Timestamp">
              {new Date(payload.event.created_at * 1000).toLocaleString()}
            </Fact>
            {payload.event.content !== "" ? (
              <Fact label="Content">
                <span className="block max-h-48 overflow-y-auto rounded-lg border border-hairline bg-ink/[0.025] p-2 text-[11.5px] leading-snug whitespace-pre-wrap">
                  {payload.event.content}
                </span>
              </Fact>
            ) : null}
            {payload.event.tags.length > 0 ? (
              <Fact label={`Tags (${payload.event.tags.length})`}>
                <span className="block max-h-36 overflow-y-auto rounded-lg border border-hairline bg-ink/[0.025] p-2 font-mono text-[10.5px] leading-relaxed">
                  {/* Keyed by index: tag order is meaningful and the array
                      never reorders while shown. */}
                  {payload.event.tags.map((tag, index) => (
                    <span key={index} className="block truncate" title={tag.join(" ")}>
                      {tag.join("  ")}
                    </span>
                  ))}
                </span>
              </Fact>
            ) : null}
          </>
        ) : null}

        {payload.method === "nip04.encrypt" || payload.method === "nip44.encrypt" ? (
          <>
            <Fact label="To (public key)">
              <span className="font-mono text-[10.5px] break-all">{payload.peer}</span>
            </Fact>
            <Fact label="Message">
              <span className="block max-h-48 overflow-y-auto rounded-lg border border-hairline bg-ink/[0.025] p-2 text-[11.5px] leading-snug whitespace-pre-wrap">
                {payload.plaintext}
              </span>
            </Fact>
          </>
        ) : null}

        {payload.method === "nip04.decrypt" || payload.method === "nip44.decrypt" ? (
          <>
            <Fact label="From (public key)">
              <span className="font-mono text-[10.5px] break-all">{payload.peer}</span>
            </Fact>
            <Fact label="Ciphertext">
              <span className="block max-h-36 overflow-y-auto rounded-lg border border-hairline bg-ink/[0.025] p-2 font-mono text-[10.5px] break-all">
                {payload.ciphertext}
              </span>
            </Fact>
          </>
        ) : null}

        <button
          type="button"
          onClick={() => setRawOpen((open) => !open)}
          className="flex cursor-pointer items-center gap-1 text-[11px] text-muted outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          <ChevronDown
            className={cn("size-3 transition-transform", !rawOpen && "-rotate-90")}
            aria-hidden="true"
          />
          Raw request
        </button>
        {rawOpen ? (
          <pre className="max-h-64 overflow-auto rounded-lg border border-hairline bg-ink/[0.025] p-2 font-mono text-[10.5px] leading-relaxed">
            {JSON.stringify(payload, null, 2)}
          </pre>
        ) : null}
      </div>

      <footer className="shrink-0 space-y-2 border-t border-hairline p-3">
        <label className="flex cursor-pointer items-start gap-2 text-[11.5px] leading-snug text-muted select-none">
          <Checkbox
            checked={remember}
            onCheckedChange={(checked) => setRemember(checked === true)}
            className="mt-0.5"
          />
          <span>
            {nostrRememberLabel(payload, request.host, true)} — and the same
            rule for a deny. Change it any time under Settings → Nostr.
          </span>
        </label>
        <div className="flex items-center gap-2">
          <Button
            className="flex-1"
            onClick={() =>
              void respondNostr({ requestId: request.id, approved: true, remember })
            }
          >
            Approve
          </Button>
          <Button
            variant="danger"
            className="flex-1"
            onClick={() =>
              void respondNostr({ requestId: request.id, approved: false, remember })
            }
          >
            Deny
          </Button>
        </div>
      </footer>
    </div>
  );
}

export function NostrRequestPanel() {
  const open = useSumaStore((s) => s.nostrPanelOpen);
  const setOpen = useSumaStore((s) => s.setNostrPanelOpen);
  const pending = useSumaStore((s) => s.nostrPending);
  const selectedId = useSumaStore((s) => s.nostrSelectedId);
  const selectRequest = useSumaStore((s) => s.selectNostrRequest);
  const openSettings = useSumaStore((s) => s.openSettings);

  const index = pending.findIndex((request) => request.id === selectedId);
  const selected = (index === -1 ? pending[0] : pending[index]) ?? null;
  const position = index === -1 ? 0 : index;

  return (
    <PanelChrome open={open} width={PANEL_WIDTH} label="Nostr requests">
      <header className="flex h-9 shrink-0 items-center gap-1.5 border-b border-hairline px-2.5">
        <KeyRound className="size-3 text-accent" aria-hidden="true" />
        <span className="text-[12px] font-medium text-text">Nostr request</span>
        {pending.length > 1 ? (
          <span className="flex items-center gap-0.5 text-[10.5px] text-faint">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Previous request"
              disabled={position === 0}
              onClick={() => {
                const previous = pending[position - 1];
                if (previous !== undefined) selectRequest(previous.id);
              }}
            >
              <ChevronLeft className="size-3" aria-hidden="true" />
            </Button>
            {position + 1} of {pending.length}
            <Button
              variant="ghost"
              size="icon"
              aria-label="Next request"
              disabled={position >= pending.length - 1}
              onClick={() => {
                const next = pending[position + 1];
                if (next !== undefined) selectRequest(next.id);
              }}
            >
              <ChevronRight className="size-3" aria-hidden="true" />
            </Button>
          </span>
        ) : null}
        <span className="ml-auto flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            title="Nostr settings"
            aria-label="Nostr settings"
            onClick={() => void openSettings("nostr")}
          >
            <Settings2 className="size-3" aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            title="Close"
            aria-label="Close Nostr requests"
            onClick={() => setOpen(false)}
          >
            <X className="size-3" aria-hidden="true" />
          </Button>
        </span>
      </header>

      {selected !== null ? (
        <RequestDetail key={selected.id} request={selected} />
      ) : (
        <div className="flex flex-1 items-center justify-center p-6 text-center text-[11.5px] text-faint">
          No pending requests.
        </div>
      )}
    </PanelChrome>
  );
}
