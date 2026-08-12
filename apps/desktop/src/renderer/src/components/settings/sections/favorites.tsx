/** `suma://settings/favorites` — the favorite-sites list, edited by hand. */

import { useState } from "react";
import { Trash2 } from "lucide-react";
import { MAX_FAVORITES } from "../../../../../shared/favorites";
import { isProbablyUrl, normalizeUrlInput, prettyUrl } from "../../../lib/url";
import { useSumaStore } from "../../../store";
import { FavoriteIcon } from "../../FavoriteIcon";
import { Input } from "../../ui/input";
import { Block, Group, Page, Row } from "../parts";

/**
 * The manual twin of the tab star: type an address, optionally name it, and
 * it joins the tile row under the URL bar. Bare input is normalized the way
 * the URL bar normalizes it ("github.com" is a fine answer); anything that
 * is not a web address is refused out loud rather than quietly stored.
 */
function AddFavoriteForm() {
  const favoriteCount = useSumaStore((s) => s.favorites.length);
  const addFavorite = useSumaStore((s) => s.addFavorite);
  const pushToast = useSumaStore((s) => s.pushToast);
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");

  const submit = () => {
    const raw = url.trim();
    if (raw.length === 0) return;
    const normalized = isProbablyUrl(raw) ? normalizeUrlInput(raw) : "";
    if (!/^https?:\/\//i.test(normalized)) {
      pushToast("A favorite has to be a web address, like github.com", "warning");
      return;
    }
    void addFavorite(normalized, title).then(() => {
      setUrl("");
      setTitle("");
    });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
    }
  };

  return (
    <Block
      label="Add a site"
      note={`Up to ${MAX_FAVORITES} sites. Adding an address that is already a favorite renames it instead.`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="text"
          spellCheck={false}
          autoComplete="off"
          aria-label="Address"
          placeholder="github.com"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={onKeyDown}
          className="w-[220px] font-mono placeholder:font-sans @max-md:w-[150px]"
        />
        <Input
          type="text"
          spellCheck={false}
          autoComplete="off"
          aria-label="Title"
          placeholder="Title (optional)"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={onKeyDown}
          className="w-[160px] @max-md:w-[120px]"
        />
        <button
          type="button"
          disabled={url.trim().length === 0 || favoriteCount >= MAX_FAVORITES}
          onClick={submit}
          className="h-7 cursor-pointer rounded-lg bg-accent/15 px-3 text-[12px] font-medium text-accent hover:bg-accent/25 disabled:cursor-default disabled:opacity-40 disabled:hover:bg-accent/15"
        >
          Add
        </button>
      </div>
    </Block>
  );
}

export function FavoritesPage() {
  const favorites = useSumaStore((s) => s.favorites);
  const removeFavorite = useSumaStore((s) => s.removeFavorite);

  return (
    <Page
      title="Favorite sites"
      description="The tile row under the URL bar (⌘L). Star any tab to add the page it is on, or add addresses here by hand."
    >
      <Group title="Add">
        <AddFavoriteForm />
      </Group>
      <Group title={`Sites (${favorites.length})`}>
        {favorites.length === 0 ? (
          <Row label="No favorites yet" note="Star a tab, or add an address above." />
        ) : (
          favorites.map((favorite) => (
            <div
              key={favorite.id}
              className="flex items-center gap-3 border-t border-hairline px-3.5 py-2.5 first:border-t-0"
            >
              <FavoriteIcon
                url={favorite.url}
                title={favorite.title}
                className="size-8 rounded-lg text-[13px]"
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] leading-snug text-text">
                  {favorite.title}
                </p>
                <p className="truncate font-mono text-[11px] text-faint">
                  {prettyUrl(favorite.url)}
                </p>
              </div>
              <button
                type="button"
                title="Remove favorite"
                aria-label={`Remove ${favorite.title} from favorites`}
                onClick={() => void removeFavorite(favorite.id)}
                className="grid size-6 shrink-0 cursor-pointer place-items-center rounded-md text-faint hover:bg-ink/8 hover:text-text"
              >
                <Trash2 className="size-3.5" aria-hidden="true" />
              </button>
            </div>
          ))
        )}
      </Group>
    </Page>
  );
}
