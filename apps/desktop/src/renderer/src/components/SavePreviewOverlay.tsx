/**
 * The save-preview card stack — one half of the floating overlay view's
 * stack (OverlayStack.tsx), rendered below the floating audio player and
 * NOT part of the chrome document.
 *
 * Why that view: the chrome renders BELOW the tab views, so a card drawn
 * there is invisible over a page, and raising the whole chrome would steal
 * every click from the page for as long as the card shows. The overlay view
 * sits above the tab views sized to exactly its content (OverlayStack owns
 * that measurement and the `savePreview:bounds` report), so the page stays
 * clickable everywhere else and the view vanishes when the stack empties.
 *
 * The contract with main is small: `savePreview:item` upserts a card
 * (spinner while extracting, morphing to the extracted fields when the same
 * id arrives settled), `savePreview:error` shows a transient failure card,
 * and clicking a card sends `savePreview:activate`, which main relays to
 * the chrome as `saves:openDetail`.
 *
 * Animation: each card sits in a grid cell whose rows transition 0fr↔1fr
 * (smooth appear/collapse and the loading→loaded growth), and the card
 * itself slides in from the right — OverlayStack's observers follow the
 * resulting heights frame by frame.
 */

import { useEffect, useRef, useState } from "react";
import {
  Bookmark,
  BookOpen,
  Clapperboard,
  Film,
  Globe,
  LoaderCircle,
  Newspaper,
  Podcast,
  ShoppingBag,
  TriangleAlert,
} from "lucide-react";
import type { SavedItem, SavedItemType } from "../../../shared/saves";
import popSoundUrl from "../assets/pop.mp3";
import { cn } from "../lib/cn";
import { hostOf } from "../lib/url";
import { Favicon } from "./Favicon";

/** Settled cards leave on their own after this long; hover holds them. */
const DISMISS_MS = 6000;
/** …and re-arm faster once the pointer leaves — the user has seen it. */
const DISMISS_AFTER_HOVER_MS = 2500;
/** Error cards need only long enough to be read. */
const ERROR_DISMISS_MS = 5000;
/** Must outlast the .save-preview-cell collapse in styles.css. */
const LEAVE_MS = 260;

const TYPE_META: Record<SavedItemType, { label: string; Icon: typeof Globe }> = {
  website: { label: "Website", Icon: Globe },
  article: { label: "Article", Icon: Newspaper },
  video: { label: "Video", Icon: Film },
  podcast: { label: "Podcast", Icon: Podcast },
  book: { label: "Book", Icon: BookOpen },
  product: { label: "Product", Icon: ShoppingBag },
  movie: { label: "Movie", Icon: Clapperboard },
  other: { label: "Saved", Icon: Bookmark },
};

interface PreviewCard {
  /** The item id, or a synthetic id for error cards. */
  id: string;
  item: SavedItem | null;
  error: string | null;
  leaving: boolean;
}

/**
 * The save "pop" — audible feedback the instant a capture lands, ahead of
 * the card's slide-in. One shared element, rewound per play so rapid saves
 * each click; Electron's default autoplay policy needs no user gesture, and
 * failures (missing output device, decode hiccup) just mean a silent save.
 */
const popSound = new Audio(popSoundUrl);
popSound.volume = 0.5;

function playPop(): void {
  popSound.currentTime = 0;
  void popSound.play().catch(() => undefined);
}

function Thumb({ src }: { src: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  if (failed) return null;
  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      draggable={false}
      onError={() => setFailed(true)}
      className="size-10 shrink-0 rounded-md bg-ink/8 object-cover"
    />
  );
}

function CardBody({ card }: { card: PreviewCard }) {
  if (card.error !== null) {
    return (
      <span className="flex min-w-0 items-center gap-2.5">
        <TriangleAlert className="size-4 shrink-0 text-danger" aria-hidden="true" />
        <span className="min-w-0 text-[11.5px] leading-snug text-text">{card.error}</span>
      </span>
    );
  }
  const item = card.item;
  if (item === null) return null;
  const extracting = item.status === "extracting";
  const { label, Icon } = TYPE_META[item.type];
  return (
    <span className="flex min-w-0 items-start gap-2.5">
      {/* The left slot is the state: spinner while the model works, the
          decided type icon once it lands. */}
      <span className="grid size-6 shrink-0 place-items-center rounded-full bg-accent/12 text-accent">
        {extracting ? (
          <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
        ) : (
          <Icon className="size-3" aria-hidden="true" />
        )}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-1.5">
          <span className="text-[10px] font-medium tracking-wide text-faint uppercase">
            {extracting ? "Saving…" : label}
          </span>
          {/* The site's own mark beside its host — captured with the item,
              glyph-lettered by Favicon when the tab had none. */}
          <Favicon src={item.faviconUrl} seed={hostOf(item.url)} />
          <span className="min-w-0 truncate text-[10px] text-faint">
            {hostOf(item.url)}
          </span>
        </span>
        <span className="truncate text-[12px] font-medium text-text">{item.name}</span>
        {/* The grown half: absent while extracting, unfolding (grid 0fr→1fr)
            when the extraction settles — this is the card's smooth growth. */}
        <span
          className={cn(
            "save-preview-grow",
            !extracting &&
              (item.author !== null || item.description !== "") &&
              "save-preview-grown",
          )}
        >
          <span className="flex min-w-0 flex-col gap-0.5 overflow-hidden">
            {item.author !== null ? (
              <span className="truncate pt-0.5 text-[11px] text-muted">{item.author}</span>
            ) : null}
            {item.description !== "" ? (
              <span className="line-clamp-2 text-[11px] leading-snug text-muted">
                {item.description}
              </span>
            ) : null}
          </span>
        </span>
      </span>
      {!extracting && item.imageUrl !== null ? <Thumb src={item.imageUrl} /> : null}
    </span>
  );
}

export function SavePreviewOverlay() {
  const [cards, setCards] = useState<PreviewCard[]>([]);
  const timers = useRef(new Map<string, number>());
  const errorSeq = useRef(0);
  /** Item ids that have already popped — a settle re-push stays silent. */
  const seenItemIds = useRef(new Set<string>());

  const clearTimer = (id: string): void => {
    const timer = timers.current.get(id);
    if (timer !== undefined) window.clearTimeout(timer);
    timers.current.delete(id);
  };

  const beginLeave = (id: string): void => {
    clearTimer(id);
    setCards((prev) =>
      prev.map((card) => (card.id === id ? { ...card, leaving: true } : card)),
    );
    window.setTimeout(
      () => setCards((prev) => prev.filter((card) => card.id !== id)),
      LEAVE_MS,
    );
  };

  const armDismiss = (id: string, ms: number): void => {
    clearTimer(id);
    timers.current.set(
      id,
      window.setTimeout(() => beginLeave(id), ms),
    );
  };

  useEffect(() => {
    if (!window.suma) return;
    const offs = [
      window.suma.on("savePreview:item", (item) => {
        // Pop on a FRESH save only — never on an extraction settling into a
        // known card (even one already dismissed), and outside the state
        // updater, which StrictMode is allowed to run twice.
        if (!seenItemIds.current.has(item.id)) {
          seenItemIds.current.add(item.id);
          playPop();
        }
        setCards((prev) => {
          const existing = prev.find((card) => card.id === item.id);
          if (existing !== undefined) {
            return prev.map((card) =>
              card.id === item.id ? { ...card, item, leaving: false } : card,
            );
          }
          return [...prev, { id: item.id, item, error: null, leaving: false }];
        });
        // Extracting cards wait for the model; settled ones start the clock.
        if (item.status === "extracting") clearTimer(item.id);
        else armDismiss(item.id, DISMISS_MS);
      }),
      window.suma.on("savePreview:error", ({ message }) => {
        errorSeq.current += 1;
        const id = `error-${String(errorSeq.current)}`;
        setCards((prev) => [...prev, { id, item: null, error: message, leaving: false }]);
        armDismiss(id, ERROR_DISMISS_MS);
      }),
    ];
    return () => offs.forEach((off) => off());
    // armDismiss/clearTimer are stable refs-in-closures; subscribing once is
    // the point — a resubscribe would drop pushes that land between renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sizing is not this component's job: OverlayStack measures the whole
  // floating stack (player + cards) and reports it to main.
  return (
    <>
      {cards.map((card) => (
        <PreviewCell
          key={card.id}
          card={card}
          onClick={() => {
            if (card.leaving) return;
            if (card.item !== null && window.suma) {
              void window.suma
                .invoke("savePreview:activate", { id: card.item.id })
                .catch(() => undefined);
            }
            beginLeave(card.id);
          }}
          onHoverStart={() => clearTimer(card.id)}
          onHoverEnd={() => {
            // Extracting cards still wait on the model; everything else
            // re-arms on a short fuse now that it has been seen.
            if (card.leaving || card.item?.status === "extracting") return;
            armDismiss(card.id, DISMISS_AFTER_HOVER_MS);
          }}
        />
      ))}
    </>
  );
}

/**
 * One grid cell in the stack. Mounts collapsed (0fr) and expands on the next
 * frame, so appearing, growing, and leaving are all the same rows
 * transition; the card inside slides horizontally on the same schedule.
 */
function PreviewCell({
  card,
  onClick,
  onHoverStart,
  onHoverEnd,
}: {
  card: PreviewCard;
  onClick: () => void;
  onHoverStart: () => void;
  onHoverEnd: () => void;
}) {
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    // Two frames, same reason as the sidebars: the collapsed state must paint
    // before the expanded one lands, or there is nothing to transition from.
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
  return (
    <div className={cn("save-preview-cell", open && "save-preview-cell-open")}>
      <div className="flex min-h-0 flex-col items-end overflow-hidden">
        <button
          type="button"
          data-overlay-item
          onClick={onClick}
          onMouseEnter={onHoverStart}
          onMouseLeave={onHoverEnd}
          aria-label={
            card.error !== null
              ? card.error
              : `Open saved item ${card.item?.name ?? ""}`
          }
          className={cn(
            // A ROW of the shared glass panel (OverlayStack), not a card of
            // its own: the panel's frost and border carry the surface, and
            // still deliberately NO drop shadow (over arbitrary pages any
            // soft shadow reads as a gray smudge — learned twice). Every
            // pixel outside the panel is the page's own, exactly.
            // w-80, not w-full: OverlayStack reads the window's width off the
            // visible rows, so the card must carry its own rather than
            // borrow whatever width the window last had.
            "save-preview-card w-80 cursor-pointer p-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-accent/40 hover:bg-ink/5",
            open ? "save-preview-card-in" : "save-preview-card-out",
            card.error !== null && "bg-danger/5",
          )}
        >
          <CardBody card={card} />
        </button>
      </div>
    </div>
  );
}
