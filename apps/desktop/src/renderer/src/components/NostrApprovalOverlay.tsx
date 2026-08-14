/**
 * The Nostr approval cards — the third resident of the floating overlay
 * stack (OverlayStack.tsx), between the audio player and the save-preview
 * cards. When a page calls `window.nostr` and the site's standing rules say
 * "ask", main parks the call and pushes the queue here; the card is how the
 * user answers without leaving the page.
 *
 * Stacking: pending requests queue oldest-first in main, but only the HEAD
 * is shown as a full card — a burst of sign requests must not wallpaper the
 * page. The rest are one line ("N more waiting"). Answering animates the
 * card out (the shared grid-cell collapse) and the next request enters with
 * the standard slide-in, because it mounts as a fresh cell.
 *
 * Unlike save cards these are ACTIONABLE, so there is no auto-dismiss
 * timer: an unanswered request waits until the user answers, the page
 * navigates, or the tab closes (main resolves those itself and pushes the
 * shrunken queue).
 *
 * Layout constraint inherited from the stack: each visible row carries
 * data-overlay-item on its CLIPPING wrapper and its own w-80 — OverlayStack
 * measures rows to size the view, and the view swallows clicks over its
 * whole rect (see SavePreviewOverlay for the history).
 */

import { useEffect, useRef, useState } from "react";
import { KeyRound, PanelRight } from "lucide-react";
import {
  nostrRememberLabel,
  nostrRequestSummary,
  type NostrPendingRequest,
} from "../../../shared/nostr";
import { cn } from "../lib/cn";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { OVERLAY_CARD } from "./ui/overlay-card";

/** Must outlast the .save-preview-cell collapse in styles.css. */
const LEAVE_MS = 260;

interface ApprovalCard {
  request: NostrPendingRequest;
  leaving: boolean;
}

export function NostrApprovalOverlay() {
  const [cards, setCards] = useState<ApprovalCard[]>([]);
  /** Ids already answered here — keeps a queue push from resurrecting a
   *  card that is mid-leave (main's push can race the animation). */
  const answered = useRef(new Set<string>());

  const applyQueue = (pending: NostrPendingRequest[]): void => {
    setCards((prev) => {
      const incoming = pending.filter((r) => !answered.current.has(r.id));
      const next: ApprovalCard[] = [];
      // Cards that vanished from the queue (answered elsewhere, page gone)
      // leave with the same animation as a local answer.
      for (const card of prev) {
        if (incoming.some((r) => r.id === card.request.id)) continue;
        if (!card.leaving) scheduleUnmount(card.request.id);
        next.push({ ...card, leaving: true });
      }
      for (const request of incoming) {
        const existing = prev.find((c) => c.request.id === request.id);
        next.push(existing ?? { request, leaving: false });
      }
      return next;
    });
  };

  const scheduleUnmount = (id: string): void => {
    window.setTimeout(() => {
      setCards((prev) => prev.filter((c) => c.request.id !== id));
      answered.current.delete(id);
    }, LEAVE_MS);
  };

  useEffect(() => {
    if (!window.suma) return;
    const off = window.suma.on("nostr:pendingChanged", applyQueue);
    // Pull on mount: pushes sent before this view existed are gone.
    void window.suma
      .invoke("nostr:pending", undefined)
      .then(applyQueue)
      .catch(() => undefined);
    return off;
    // applyQueue/scheduleUnmount close over stable refs; one subscription is
    // the point (see SavePreviewOverlay for the same shape).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const respond = (card: ApprovalCard, approved: boolean, remember: boolean): void => {
    answered.current.add(card.request.id);
    setCards((prev) =>
      prev.map((c) =>
        c.request.id === card.request.id ? { ...c, leaving: true } : c,
      ),
    );
    scheduleUnmount(card.request.id);
    if (window.suma) {
      void window.suma
        .invoke("nostr:respond", {
          requestId: card.request.id,
          approved,
          remember,
        })
        .catch(() => undefined);
    }
  };

  const live = cards.filter((c) => !c.leaving);
  const head = live[0] ?? null;
  const waiting = live.length - 1;

  return (
    <>
      <KeyMissingNotice />
      {cards.map((card) => {
        const isHead = head !== null && card.request.id === head.request.id;
        if (!isHead && !card.leaving) return null;
        return (
          <ApprovalCell
            key={card.request.id}
            card={card}
            waiting={isHead ? waiting : 0}
            onRespond={(approved, remember) => respond(card, approved, remember)}
            onExpand={() => {
              if (!window.suma) return;
              void window.suma
                .invoke("nostr:expand", { requestId: card.request.id })
                .catch(() => undefined);
            }}
          />
        );
      })}
    </>
  );
}

/** The key-missing nudge holds long enough to act on, not forever. */
const NOTICE_DISMISS_MS = 10_000;

/**
 * A site called `window.nostr`, but no key is configured. The page already
 * got its error; this card is the USER's copy — without it, coracle's
 * "sign in with extension" button just silently does nothing. Main
 * throttles it per host, so one card per site per minute at most.
 */
function KeyMissingNotice() {
  const [host, setHost] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const dismissTimer = useRef(0);

  const dismiss = (): void => {
    window.clearTimeout(dismissTimer.current);
    setLeaving(true);
    window.setTimeout(() => {
      setHost(null);
      setLeaving(false);
    }, LEAVE_MS);
  };

  useEffect(() => {
    if (!window.suma) return;
    const off = window.suma.on("nostr:keyMissing", ({ host: nudgedHost }) => {
      window.clearTimeout(dismissTimer.current);
      setHost(nudgedHost);
      setLeaving(false);
      dismissTimer.current = window.setTimeout(dismiss, NOTICE_DISMISS_MS);
    });
    return () => {
      off();
      window.clearTimeout(dismissTimer.current);
    };
  }, []);

  if (host === null) return null;
  return (
    <NoticeCell host={host} leaving={leaving} onDismiss={dismiss} />
  );
}

function NoticeCell({
  host,
  leaving,
  onDismiss,
}: {
  host: string;
  leaving: boolean;
  onDismiss: () => void;
}) {
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setEntered(true));
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, []);

  const open = entered && !leaving;
  return (
    <div
      data-overlay-row
      data-open={open}
      className={cn("save-preview-cell", open && "save-preview-cell-open")}
    >
      <div className="flex min-h-0 flex-col items-end overflow-hidden">
        <div
          data-overlay-item
          className={cn(
            OVERLAY_CARD,
            "save-preview-card w-80 p-2.5 text-left",
            open ? "save-preview-card-in" : "save-preview-card-out",
          )}
        >
          <div className="flex min-w-0 items-start gap-2.5">
            <span className="grid size-6 shrink-0 place-items-center rounded-full bg-warn/15 text-warn">
              <KeyRound className="size-3" aria-hidden="true" />
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="flex items-center gap-1.5">
                <span className="text-[10px] font-medium tracking-wide text-faint uppercase">
                  Nostr
                </span>
                <span className="min-w-0 truncate text-[10px] text-faint">{host}</span>
              </span>
              <span className="text-[12px] font-medium text-text">
                This site wants to use your Nostr key
              </span>
              <span className="text-[11px] leading-snug text-muted">
                No key is set up yet, so the request was refused.
              </span>
              <span className="mt-1.5 flex items-center gap-1.5">
                <Button
                  size="sm"
                  onClick={() => {
                    if (window.suma) {
                      void window.suma
                        .invoke("nostr:openSettings", undefined)
                        .catch(() => undefined);
                    }
                    onDismiss();
                  }}
                >
                  Set up a key
                </Button>
                <Button variant="ghost" size="sm" onClick={onDismiss}>
                  Dismiss
                </Button>
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * One request, same cell mechanics as a save card: mounts collapsed,
 * expands on the second frame, collapses to leave.
 */
function ApprovalCell({
  card,
  waiting,
  onRespond,
  onExpand,
}: {
  card: ApprovalCard;
  waiting: number;
  onRespond: (approved: boolean, remember: boolean) => void;
  onExpand: () => void;
}) {
  const [entered, setEntered] = useState(false);
  const [remember, setRemember] = useState(false);
  useEffect(() => {
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setEntered(true));
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, []);

  const { request } = card;
  const open = entered && !card.leaving;
  return (
    <div
      data-overlay-row
      data-open={open}
      className={cn("save-preview-cell", open && "save-preview-cell-open")}
    >
      <div className="flex min-h-0 flex-col items-end overflow-hidden">
        <div
          data-overlay-item
          className={cn(
            OVERLAY_CARD,
            "save-preview-card w-80 p-2.5 text-left",
            open ? "save-preview-card-in" : "save-preview-card-out",
          )}
        >
          <div className="flex min-w-0 items-start gap-2.5">
            <span className="grid size-6 shrink-0 place-items-center rounded-full bg-accent/12 text-accent">
              <KeyRound className="size-3" aria-hidden="true" />
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="flex items-center gap-1.5">
                <span className="text-[10px] font-medium tracking-wide text-faint uppercase">
                  Nostr
                </span>
                <span className="min-w-0 truncate text-[10px] text-faint">
                  {request.host}
                </span>
                {/* Open the full request in the chrome's detail panel — the
                    card stays: expanding is looking, not answering. */}
                <button
                  type="button"
                  title="Show full request details"
                  aria-label="Show full request details"
                  onClick={onExpand}
                  className="ml-auto -mr-0.5 grid size-5 cursor-pointer place-items-center rounded-md text-faint outline-none hover:bg-ink/8 hover:text-text focus-visible:ring-2 focus-visible:ring-accent/40"
                >
                  <PanelRight className="size-3" aria-hidden="true" />
                </button>
              </span>
              <span className="text-[12px] font-medium text-text">
                {nostrRequestSummary(request.payload)}
              </span>
              {request.payload.method === "signEvent" &&
              request.payload.event.content !== "" ? (
                <span className="line-clamp-2 text-[11px] leading-snug break-words text-muted">
                  {request.payload.event.content}
                </span>
              ) : null}
              <span className="mt-1.5 flex items-center gap-1.5">
                <Button size="sm" onClick={() => onRespond(true, remember)}>
                  Approve
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => onRespond(false, remember)}
                >
                  Deny
                </Button>
                <label
                  title={nostrRememberLabel(request.payload, request.host, true)}
                  className="ml-auto flex cursor-pointer items-center gap-1 text-[10px] text-faint select-none"
                >
                  <Checkbox
                    checked={remember}
                    onCheckedChange={(checked) => setRemember(checked === true)}
                    className="size-3.5"
                  />
                  Remember
                </label>
              </span>
              {waiting > 0 ? (
                <span className="mt-1 text-[10px] text-faint">
                  {waiting} more {waiting === 1 ? "request" : "requests"} waiting
                </span>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
