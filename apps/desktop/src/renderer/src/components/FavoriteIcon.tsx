import { useEffect, useState } from "react";
import { cn } from "../lib/cn";
import { hostOf } from "../lib/url";

/**
 * A favorite site's large mark. Tries the site's apple-touch-icon at its
 * conventional root path first — the closest thing the web has to an app
 * icon — then Google's favicon service, then an initial-letter tile. The
 * chain is walked by <img> error events, so a site that serves an HTML 404
 * at the icon path degrades the same way as one that serves nothing.
 *
 * Size AND corner radius come from the caller (`className`): the URL-bar
 * tile, its recent chips, and the settings row all want the same chain at
 * different sizes, and cn() cannot resolve a rounded-* conflict, so the base
 * bakes none in.
 */
export function FavoriteIcon({
  url,
  title,
  className,
}: {
  url: string;
  title: string;
  className?: string;
}) {
  const host = hostOf(url);
  // sz=128, not Favicon's 32: these render up to 64px, where a 32px
  // bitmap goes soft.
  const sources =
    host === ""
      ? []
      : [
          `https://${host}/apple-touch-icon.png`,
          `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=128`,
        ];
  const [attempt, setAttempt] = useState(0);
  useEffect(() => setAttempt(0), [url]);

  const src = sources[attempt];
  if (src === undefined) {
    const letter =
      (host.replace(/^www\./, "") || title).charAt(0).toUpperCase() || "•";
    return (
      <span
        className={cn(
          "grid shrink-0 place-items-center bg-ink/8 font-semibold text-muted",
          className,
        )}
      >
        {letter}
      </span>
    );
  }
  return (
    <img
      src={src}
      alt=""
      draggable={false}
      onError={() => setAttempt((a) => a + 1)}
      className={cn("shrink-0 object-cover", className)}
    />
  );
}
