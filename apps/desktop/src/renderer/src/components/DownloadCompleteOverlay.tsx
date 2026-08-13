/**
 * The download-complete cards — a resident of the floating overlay stack
 * (OverlayStack.tsx), between the Nostr approvals and the save-preview cards.
 *
 * Why this view and not a chrome toast: a download finishes while the user is
 * on a page, and the chrome renders BELOW the tab views, so the chrome's
 * toast pile (App.tsx) is invisible at exactly the moment this needs to be
 * seen. The overlay view sits above the pages, sized to its own content, so
 * the card appears over whatever is open and the rest of the page stays
 * clickable.
 *
 * The contract with main is two channels: `downloadOverlay:completed` pushes
 * one card per finished file (main only emits it for `completed` items —
 * a cancelled or cloud-routed download has nothing to open), and "Open"
 * sends `downloadOverlay:open` with the download's id, which main resolves to
 * the save path it recorded. No path ever crosses this boundary.
 *
 * Layout constraints inherited from the panel: each row carries
 * data-overlay-item on its CLIPPING wrapper and its own w-80 — OverlayStack
 * measures the visible rows to size the view (see SavePreviewOverlay for the
 * history behind both).
 */

import { useEffect, useRef, useState } from "react";
import { CircleCheck } from "lucide-react";
import type { DownloadItemInfo } from "../../../shared/ipc";
import { cn } from "../lib/cn";
import { formatBytes } from "../lib/format";
import { Button } from "./ui/button";

/** Long enough to notice and act on; hover holds it open. */
const DISMISS_MS = 8000;
/** …and re-arms on a short fuse once the pointer leaves — it has been seen. */
const DISMISS_AFTER_HOVER_MS = 2500;
/** Must outlast the .save-preview-cell collapse in styles.css. */
const LEAVE_MS = 260;
/**
 * A batch download (a page firing off a dozen files) must not wallpaper the
 * page. Beyond this the oldest card leaves early; the full list is always in
 * the downloads panel.
 */
const MAX_CARDS = 3;

interface CompletedCard {
  item: DownloadItemInfo;
  leaving: boolean;
}

export function DownloadCompleteOverlay() {
  const [cards, setCards] = useState<CompletedCard[]>([]);
  /** Auto-dismiss fuses, one per live card. */
  const dismissTimers = useRef(new Map<string, number>());
  /** Unmount fuses, one per card that has started leaving. */
  const unmountTimers = useRef(new Map<string, number>());

  const clearDismiss = (id: string): void => {
    const timer = dismissTimers.current.get(id);
    if (timer !== undefined) window.clearTimeout(timer);
    dismissTimers.current.delete(id);
  };

  /** Mark leaving; the sweeper below owns the unmount that follows. */
  const beginLeave = (id: string): void => {
    setCards((prev) =>
      prev.map((card) => (card.item.id === id ? { ...card, leaving: true } : card)),
    );
  };

  const armDismiss = (id: string, ms: number): void => {
    clearDismiss(id);
    dismissTimers.current.set(
      id,
      window.setTimeout(() => beginLeave(id), ms),
    );
  };

  // Every card marked leaving — by its fuse, by a click, or by overflow —
  // unmounts once, LEAVE_MS later. Doing it here rather than inside the state
  // updaters keeps those updaters pure (StrictMode runs them twice) and means
  // there is exactly one place that retires a card.
  useEffect(() => {
    for (const card of cards) {
      const id = card.item.id;
      if (!card.leaving || unmountTimers.current.has(id)) continue;
      clearDismiss(id);
      unmountTimers.current.set(
        id,
        window.setTimeout(() => {
          unmountTimers.current.delete(id);
          setCards((prev) => prev.filter((c) => c.item.id !== id));
        }, LEAVE_MS),
      );
    }
  }, [cards]);

  useEffect(() => {
    if (!window.suma) return;
    // Captured for the cleanup: the Maps themselves outlive every render, so
    // reading .current at teardown is the same object either way — but the
    // lint rule cannot know that.
    const dismissing = dismissTimers.current;
    const unmounting = unmountTimers.current;
    const off = window.suma.on("downloadOverlay:completed", (item) => {
      setCards((prev) => {
        // Main pushes once per download, but a re-push must refresh the card
        // rather than stack a twin.
        const next = prev.some((card) => card.item.id === item.id)
          ? prev.map((card) =>
              card.item.id === item.id ? { item, leaving: false } : card,
            )
          : [...prev, { item, leaving: false }];
        // The overflow leaves with the normal animation rather than being
        // dropped from the array — an unmount here would make the panel jump
        // instead of collapse.
        const doomed = new Set(
          next
            .filter((card) => !card.leaving)
            .slice(0, -MAX_CARDS)
            .map((card) => card.item.id),
        );
        if (doomed.size === 0) return next;
        return next.map((card) =>
          doomed.has(card.item.id) ? { ...card, leaving: true } : card,
        );
      });
      armDismiss(item.id, DISMISS_MS);
    });
    return () => {
      off();
      for (const timer of dismissing.values()) window.clearTimeout(timer);
      for (const timer of unmounting.values()) window.clearTimeout(timer);
      dismissing.clear();
      unmounting.clear();
    };
    // armDismiss/beginLeave close over stable refs; subscribing once is the
    // point — a resubscribe would drop pushes landing between renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sizing is OverlayStack's job: it measures the whole floating stack.
  return (
    <>
      {cards.map((card) => (
        <CompletedCell
          key={card.item.id}
          card={card}
          onOpen={() => {
            if (window.suma) {
              void window.suma
                .invoke("downloadOverlay:open", { id: card.item.id })
                .catch(() => undefined);
            }
            beginLeave(card.item.id);
          }}
          onDismiss={() => beginLeave(card.item.id)}
          onHoverStart={() => clearDismiss(card.item.id)}
          onHoverEnd={() => {
            if (card.leaving) return;
            armDismiss(card.item.id, DISMISS_AFTER_HOVER_MS);
          }}
        />
      ))}
    </>
  );
}

/**
 * One grid cell in the stack — the same mechanics as a save card: mounts
 * collapsed (0fr), expands on the second frame, collapses to leave, with the
 * card sliding in from the right on the same schedule.
 */
function CompletedCell({
  card,
  onOpen,
  onDismiss,
  onHoverStart,
  onHoverEnd,
}: {
  card: CompletedCard;
  onOpen: () => void;
  onDismiss: () => void;
  onHoverStart: () => void;
  onHoverEnd: () => void;
}) {
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    // Two frames: the collapsed state must paint before the expanded one
    // lands, or there is nothing to transition from.
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setEntered(true));
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, []);

  const open = entered && !card.leaving;
  const size = formatBytes(card.item.receivedBytes);
  return (
    <div className={cn("save-preview-cell", open && "save-preview-cell-open")}>
      <div className="flex min-h-0 flex-col items-end overflow-hidden">
        <div
          data-overlay-item
          onMouseEnter={onHoverStart}
          onMouseLeave={onHoverEnd}
          className={cn(
            "save-preview-card w-80 p-2.5 text-left",
            open ? "save-preview-card-in" : "save-preview-card-out",
          )}
        >
          <div className="flex min-w-0 items-start gap-2.5">
            <span className="grid size-6 shrink-0 place-items-center rounded-full bg-ok/15 text-ok">
              <CircleCheck className="size-3.5" aria-hidden="true" />
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="flex items-center gap-1.5">
                <span className="text-[10px] font-medium tracking-wide text-faint uppercase">
                  Download complete
                </span>
                <span className="min-w-0 truncate text-[10px] text-faint">{size}</span>
              </span>
              {/* The filename is the whole message — no second line repeating
                  what the eyebrow already said. */}
              <span className="truncate text-[12px] font-medium text-text">
                {card.item.filename}
              </span>
              <span className="mt-1.5 flex items-center gap-1.5">
                <Button size="sm" onClick={onOpen}>
                  Open
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
