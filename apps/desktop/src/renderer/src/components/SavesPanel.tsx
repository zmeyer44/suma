/**
 * The Saves panel (⌘B, or the bookmark button in the tab strip; a save itself
 * is triggered by double-tapping Shift on any page).
 *
 * Structurally the chat sidebar's twin (see ChatSidebar.tsx for why a flex
 * sibling of the content hole, the slide-in choreography, and the resize
 * handle work the way they do): opening it narrows the hole and the tab
 * views resize to match. Two views inside one panel:
 *
 *  - the LIST: searchable cards, newest first, each showing what the
 *    extractor decided the item is;
 *  - the DETAIL: every extracted field editable in place. A fresh capture
 *    drops the user here (store: saves:captured → savesSelectedId), which is
 *    how "show what we assumed, make it easy to correct" happens — no
 *    confirmation dialog, just the finished card ready to be fixed.
 */

import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  Bookmark,
  BookmarkPlus,
  BookOpen,
  Clapperboard,
  ExternalLink,
  Film,
  Globe,
  LoaderCircle,
  Newspaper,
  Plus,
  Podcast,
  Search,
  ShoppingBag,
  Trash2,
  X,
} from "lucide-react";
import {
  matchesSavesQuery,
  SAVED_ITEM_TYPES,
  type SavedItem,
  type SavedItemType,
} from "../../../shared/saves";
import { cn } from "../lib/cn";
import { agoLabel } from "../lib/format";
import {
  SAVES_DEFAULT_WIDTH,
  SAVES_MAX_WIDTH,
  SAVES_MIN_WIDTH,
} from "../lib/saves";
import { hostOf } from "../lib/url";
import { selectActiveTab, useSumaStore } from "../store";
import { Favicon } from "./Favicon";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Marker, MarkerContent, MarkerIcon } from "./ui/marker";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { Textarea } from "./ui/textarea";

/** Slide durations — MUST match `.chat-slide` in styles.css (shared class). */
const OPEN_MS = 220;
const CLOSE_MS = 160;

/** Keyboard resize step (←/→ on the focused handle), in px. */
const KEY_STEP = 24;
/** Hit area around the 2px rule — same forgiving seam as the chat handle. */
const HANDLE_W = 7;

const TYPE_META: Record<
  SavedItemType,
  { label: string; Icon: typeof Globe }
> = {
  website: { label: "Website", Icon: Globe },
  article: { label: "Article", Icon: Newspaper },
  video: { label: "Video", Icon: Film },
  podcast: { label: "Podcast", Icon: Podcast },
  book: { label: "Book", Icon: BookOpen },
  product: { label: "Product", Icon: ShoppingBag },
  movie: { label: "Movie", Icon: Clapperboard },
  other: { label: "Other", Icon: Bookmark },
};

/** The same list in the `{ value, label }` shape Select reads for its trigger. */
const TYPE_ITEMS = SAVED_ITEM_TYPES.map((type) => ({
  value: type,
  label: TYPE_META[type].label,
}));

/** Same mechanism as the chat sidebar's handle — see ChatSidebar.ResizeHandle
 *  for why `setPaneResizing` is load-bearing. Only the store setters differ. */
function ResizeHandle({ width }: { width: number }) {
  const setSavesWidth = useSumaStore((s) => s.setSavesWidth);
  const setPaneResizing = useSumaStore((s) => s.setPaneResizing);
  const resizing = useSumaStore((s) => s.paneResizing);

  const onPointerDown = (e: React.PointerEvent): void => {
    if (e.button !== 0) return;
    e.preventDefault();
    setPaneResizing(true);
    let raf = 0;
    let pendingX = e.clientX;
    const apply = (): void => {
      raf = 0;
      setSavesWidth(window.innerWidth - pendingX);
    };
    const onMove = (ev: PointerEvent): void => {
      pendingX = ev.clientX;
      if (raf === 0) raf = requestAnimationFrame(apply);
    };
    const onUp = (): void => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (raf !== 0) cancelAnimationFrame(raf);
      setPaneResizing(false);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    setSavesWidth(width + (e.key === "ArrowLeft" ? KEY_STEP : -KEY_STEP));
  };

  return (
    <>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize saves panel"
        aria-valuenow={width}
        aria-valuemin={SAVES_MIN_WIDTH}
        aria-valuemax={SAVES_MAX_WIDTH}
        tabIndex={0}
        title="Drag to resize — double-click to reset"
        style={{ width: HANDLE_W, left: -Math.round(HANDLE_W / 2) }}
        onPointerDown={onPointerDown}
        onDoubleClick={() => setSavesWidth(SAVES_DEFAULT_WIDTH)}
        onKeyDown={onKeyDown}
        className="group absolute inset-y-0 z-10 cursor-col-resize outline-none"
      >
        <div
          className={cn(
            "mx-auto h-full w-[2px] rounded-full transition-colors",
            resizing
              ? "bg-accent/60"
              : "bg-transparent group-hover:bg-ink/25 group-focus-visible:bg-accent/50",
          )}
        />
      </div>
      {resizing ? <div className="fixed inset-0 z-50 cursor-col-resize" /> : null}
    </>
  );
}

/** Card thumbnail that quietly disappears when the image fails to load. */
function Thumb({ src, alt, large }: { src: string; alt: string; large?: boolean }) {
  const [failed, setFailed] = useState(false);
  // A new src deserves a new attempt (the user may have just fixed the URL).
  useEffect(() => setFailed(false), [src]);
  if (failed) return null;
  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      draggable={false}
      onError={() => setFailed(true)}
      className={cn(
        "shrink-0 rounded-md bg-ink/8 object-cover",
        large ? "h-32 w-full" : "size-12",
      )}
    />
  );
}

function TypeBadge({ type }: { type: SavedItemType }) {
  const { label, Icon } = TYPE_META[type];
  return (
    <span className="inline-flex items-center gap-1 rounded bg-ink/8 px-1.5 py-0.5 text-[10px] font-medium text-muted">
      <Icon className="size-2.5" aria-hidden="true" />
      {label}
    </span>
  );
}

function SaveCard({ item, onOpen }: { item: SavedItem; onOpen: () => void }) {
  const extracting = item.status === "extracting";
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full cursor-pointer items-start gap-2.5 rounded-lg border border-hairline bg-ink/3 p-2.5 text-left transition-colors hover:border-ink/20 hover:bg-ink/8"
    >
      {item.imageUrl !== null ? <Thumb src={item.imageUrl} alt="" /> : null}
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex items-center gap-1.5">
          <TypeBadge type={item.type} />
          {extracting ? (
            <LoaderCircle
              className="size-3 animate-spin text-accent"
              aria-hidden="true"
            />
          ) : null}
          <span className="ml-auto shrink-0 text-[10px] text-faint">
            {agoLabel(item.savedAtMs)}
          </span>
        </span>
        <span className="truncate text-[12.5px] font-medium text-text">
          {item.name}
        </span>
        {item.author !== null ? (
          <span className="truncate text-[11px] text-muted">{item.author}</span>
        ) : null}
        {item.description !== "" ? (
          <span className="line-clamp-2 text-[11px] leading-snug text-muted">
            {item.description}
          </span>
        ) : null}
        <span className="flex flex-wrap items-center gap-1">
          <Favicon src={item.faviconUrl} seed={hostOf(item.url) || item.url} />
          <span className="truncate text-[10px] text-faint">
            {hostOf(item.url) || item.url}
          </span>
          {item.tags.map((tag) => (
            <span
              key={tag}
              className="rounded-full bg-accent/12 px-1.5 py-px text-[9.5px] text-accent"
            >
              {tag}
            </span>
          ))}
        </span>
      </span>
    </button>
  );
}

/** A labelled field in the detail editor. */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] font-medium tracking-wide text-faint uppercase">
        {label}
      </span>
      {children}
    </label>
  );
}

/**
 * The editable detail view. Text fields are draft-local and commit on blur or
 * Enter — every keystroke round-tripping through IPC would fight the
 * `saves:updated` pushes. `key={item.id}` on the mount resets drafts when the
 * shown item changes; extraction landing mid-edit updates only the fields the
 * user hasn't touched (drafts win until committed).
 */
function SavesDetail({ item, onBack }: { item: SavedItem; onBack: () => void }) {
  const updateSavedItem = useSumaStore((s) => s.updateSavedItem);
  const deleteSavedItem = useSumaStore((s) => s.deleteSavedItem);
  const createTab = useSumaStore((s) => s.createTab);
  const pushToast = useSumaStore((s) => s.pushToast);

  const [name, setName] = useState(item.name);
  const [description, setDescription] = useState(item.description);
  const [author, setAuthor] = useState(item.author ?? "");
  const [imageUrl, setImageUrl] = useState(item.imageUrl ?? "");
  const [newTag, setNewTag] = useState("");
  const touched = useRef<Set<string>>(new Set());

  // Extraction settling replaces the placeholder fields — mirror the ones the
  // user hasn't started editing, so the refinement isn't stomped by drafts.
  useEffect(() => {
    if (!touched.current.has("name")) setName(item.name);
    if (!touched.current.has("description")) setDescription(item.description);
    if (!touched.current.has("author")) setAuthor(item.author ?? "");
    if (!touched.current.has("imageUrl")) setImageUrl(item.imageUrl ?? "");
  }, [item.name, item.description, item.author, item.imageUrl]);

  const commit = (): void => {
    const patch: Parameters<typeof updateSavedItem>[1] = {};
    if (name.trim() !== "" && name !== item.name) patch.name = name;
    if (description !== item.description) patch.description = description;
    if (author !== (item.author ?? "")) {
      patch.author = author.trim() === "" ? null : author;
    }
    if (imageUrl !== (item.imageUrl ?? "")) {
      patch.imageUrl = imageUrl.trim() === "" ? null : imageUrl;
    }
    if (Object.keys(patch).length === 0) return;
    touched.current.clear();
    void updateSavedItem(item.id, patch);
  };

  const addTag = (): void => {
    const tag = newTag.trim();
    if (tag === "") return;
    setNewTag("");
    void updateSavedItem(item.id, { tags: [...item.tags, tag] });
  };

  const removeTag = (tag: string): void => {
    void updateSavedItem(item.id, {
      tags: item.tags.filter((t) => t !== tag),
    });
  };

  const commitOnEnter = (e: React.KeyboardEvent): void => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-hairline px-2 py-1.5">
        <Button variant="ghost" size="icon" title="Back" aria-label="Back to all saves" onClick={onBack}>
          <ArrowLeft className="size-3" aria-hidden="true" />
        </Button>
        <TypeBadge type={item.type} />
        {item.status === "extracting" ? (
          <span className="flex items-center gap-1 text-[10.5px] text-accent">
            <LoaderCircle className="size-3 animate-spin" aria-hidden="true" />
            Identifying…
          </span>
        ) : null}
        <span className="ml-auto flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            title="Open page"
            aria-label="Open page"
            onClick={() => void createTab(item.url)}
          >
            <ExternalLink className="size-3" aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            title="Delete"
            aria-label="Delete saved item"
            className="hover:text-danger"
            onClick={() => {
              void deleteSavedItem(item.id);
              pushToast("Removed from saves", "success");
              onBack();
            }}
          >
            <Trash2 className="size-3" aria-hidden="true" />
          </Button>
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-3 p-2.5">
          {imageUrl.trim() !== "" ? <Thumb src={imageUrl} alt="" large /> : null}

          <Field label="Name">
            <Input
              value={name}
              onChange={(e) => {
                touched.current.add("name");
                setName(e.target.value);
              }}
              onBlur={commit}
              onKeyDown={commitOnEnter}
              className="w-full"
            />
          </Field>

          <Field label="Type">
            {/* The one field that commits immediately: a type is picked from a
                closed set, so there is no half-typed state to protect. */}
            <Select
              value={item.type}
              items={TYPE_ITEMS}
              onValueChange={(type: SavedItemType) => {
                void updateSavedItem(item.id, { type });
              }}
            >
              <SelectTrigger aria-label="Type" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SAVED_ITEM_TYPES.map((type) => (
                  <SelectItem key={type} value={type}>
                    {TYPE_META[type].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field label="Description">
            <Textarea
              rows={3}
              value={description}
              onChange={(e) => {
                touched.current.add("description");
                setDescription(e.target.value);
              }}
              onBlur={commit}
              className="w-full resize-none"
            />
          </Field>

          <Field label="Author / creator">
            <Input
              value={author}
              placeholder="None"
              onChange={(e) => {
                touched.current.add("author");
                setAuthor(e.target.value);
              }}
              onBlur={commit}
              onKeyDown={commitOnEnter}
              className="w-full"
            />
          </Field>

          <Field label="Image URL">
            <Input
              value={imageUrl}
              placeholder="None"
              spellCheck={false}
              onChange={(e) => {
                touched.current.add("imageUrl");
                setImageUrl(e.target.value);
              }}
              onBlur={commit}
              onKeyDown={commitOnEnter}
              className="w-full"
            />
          </Field>

          <div className="flex flex-col gap-1">
            <span className="text-[10px] font-medium tracking-wide text-faint uppercase">
              Tags
            </span>
            <div className="flex flex-wrap items-center gap-1">
              {item.tags.map((tag) => (
                <span
                  key={tag}
                  className="inline-flex items-center gap-0.5 rounded-full bg-accent/12 py-0.5 pr-1 pl-2 text-[10.5px] text-accent"
                >
                  {tag}
                  <button
                    type="button"
                    title="Remove tag"
                    aria-label={`Remove tag ${tag}`}
                    onClick={() => removeTag(tag)}
                    className="cursor-pointer rounded-full p-0.5 hover:bg-accent/20"
                  >
                    <X className="size-2.5" aria-hidden="true" />
                  </button>
                </span>
              ))}
            </div>
            <div className="flex items-center gap-1">
              <Input
                value={newTag}
                placeholder="Add a tag — wishlist, gift ideas…"
                onChange={(e) => setNewTag(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addTag();
                  }
                }}
                className="w-full"
              />
              <Button
                variant="secondary"
                size="icon"
                title="Add tag"
                aria-label="Add tag"
                disabled={newTag.trim() === ""}
                onClick={addTag}
              >
                <Plus className="size-3" aria-hidden="true" />
              </Button>
            </div>
          </div>

          <div className="flex flex-col gap-1 border-t border-hairline pt-2">
            <span className="text-[10px] text-faint">Saved from</span>
            <button
              type="button"
              title={item.url}
              onClick={() => void createTab(item.url)}
              className="cursor-pointer truncate text-left text-[11px] text-accent hover:underline"
            >
              {item.url}
            </button>
            {item.selection !== null ? (
              <blockquote className="mt-1 border-l-2 border-ink/15 pl-2 text-[11px] text-muted italic">
                {item.selection}
              </blockquote>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

export function SavesPanel() {
  const open = useSumaStore((s) => s.savesOpen);
  const width = useSumaStore((s) => s.savesWidth);
  const setSavesOpen = useSumaStore((s) => s.setSavesOpen);
  const saves = useSumaStore((s) => s.saves);
  const selectedId = useSumaStore((s) => s.savesSelectedId);
  const selectSavedItem = useSumaStore((s) => s.selectSavedItem);
  const captureSave = useSumaStore((s) => s.captureSave);
  const activeTab = useSumaStore(selectActiveTab);

  const [query, setQuery] = useState("");
  const selected = saves.find((item) => item.id === selectedId) ?? null;

  // Same mount/expand choreography as the chat sidebar — see ChatSidebar for
  // the two-frame explanation. Only the <aside> unmounts; the component stays,
  // so search text and selection survive a close.
  const [mounted, setMounted] = useState(open);
  const [expanded, setExpanded] = useState(open);
  const [animating, setAnimating] = useState(false);
  const firstRun = useRef(true);

  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    if (open) {
      setMounted(true);
      setAnimating(true);
      let inner = 0;
      const outer = requestAnimationFrame(() => {
        inner = requestAnimationFrame(() => setExpanded(true));
      });
      const settle = window.setTimeout(() => setAnimating(false), OPEN_MS + 60);
      return () => {
        cancelAnimationFrame(outer);
        cancelAnimationFrame(inner);
        window.clearTimeout(settle);
      };
    }
    setAnimating(true);
    setExpanded(false);
    const settle = window.setTimeout(() => {
      setMounted(false);
      setAnimating(false);
    }, CLOSE_MS);
    return () => window.clearTimeout(settle);
  }, [open]);

  if (!mounted) return null;

  const filtered = saves.filter((item) => matchesSavesQuery(item, query));

  return (
    <aside
      aria-label="Saves"
      inert={open ? undefined : true}
      data-closing={open ? undefined : ""}
      style={{ width: expanded ? width : 0 }}
      className={cn("no-drag relative h-full shrink-0", animating && "chat-slide")}
    >
      <ResizeHandle width={width} />

      <div className="h-full w-full overflow-hidden">
        <div
          style={{ width }}
          className="flex h-full flex-col border-l border-chrome-edge bg-chrome"
        >
          <header className="flex h-9 shrink-0 items-center gap-1.5 border-b border-hairline px-2.5">
            <Bookmark className="size-3 text-accent" aria-hidden="true" />
            <span className="text-[12px] font-medium text-text">Saves</span>
            {saves.length > 0 ? (
              <span className="text-[10.5px] text-faint">{saves.length}</span>
            ) : null}
            <span className="ml-auto flex items-center gap-0.5">
              <Button
                variant="ghost"
                size="icon"
                title="Save this page (double-tap Shift)"
                aria-label="Save this page"
                disabled={activeTab === null}
                onClick={() => void captureSave()}
              >
                <BookmarkPlus className="size-3" aria-hidden="true" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                title="Close saves (⌘B)"
                aria-label="Close saves"
                onClick={() => setSavesOpen(false)}
              >
                <X className="size-3" aria-hidden="true" />
              </Button>
            </span>
          </header>

          {selected !== null ? (
            <SavesDetail
              key={selected.id}
              item={selected}
              onBack={() => selectSavedItem(null)}
            />
          ) : (
            <>
              <div className="shrink-0 border-b border-hairline p-2">
                <div className="flex items-center gap-1.5 rounded-lg border border-hairline bg-bg/60 px-2 py-1 focus-within:border-accent/60 focus-within:ring-2 focus-within:ring-accent/20">
                  <Search className="size-3 shrink-0 text-faint" aria-hidden="true" />
                  <Input
                    variant="bare"
                    value={query}
                    placeholder="Search saves — name, tag, author…"
                    aria-label="Search saves"
                    spellCheck={false}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => {
                      // Chords belong to the window (⌘B to close, ⌘T, …).
                      if (e.metaKey || e.ctrlKey || e.altKey) return;
                      e.stopPropagation();
                    }}
                    className="flex-1 py-0.5 text-[12px]"
                  />
                  {query !== "" ? (
                    <button
                      type="button"
                      title="Clear search"
                      aria-label="Clear search"
                      onClick={() => setQuery("")}
                      className="cursor-pointer rounded p-0.5 text-faint hover:bg-ink/8 hover:text-text"
                    >
                      <X className="size-2.5" aria-hidden="true" />
                    </button>
                  ) : null}
                </div>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto">
                {saves.length === 0 ? (
                  <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
                    <Bookmark className="size-5 text-ink/25" aria-hidden="true" />
                    <p className="text-[12px] text-muted">
                      Double-tap <kbd className="rounded bg-ink/8 px-1">Shift</kbd> on
                      any page to save the thing it&rsquo;s about — a book, a product,
                      an article — not just the link.
                    </p>
                    <p className="text-[11px] text-faint">
                      Highlight text first to point the save at something specific on
                      the page.
                    </p>
                  </div>
                ) : filtered.length === 0 ? (
                  <Marker variant="separator" className="mt-4">
                    <MarkerIcon>
                      <Search className="size-3" aria-hidden="true" />
                    </MarkerIcon>
                    <MarkerContent>Nothing matches this search</MarkerContent>
                  </Marker>
                ) : (
                  <div className="flex flex-col gap-1.5 p-2">
                    {filtered.map((item) => (
                      <SaveCard
                        key={item.id}
                        item={item}
                        onOpen={() => selectSavedItem(item.id)}
                      />
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </aside>
  );
}
