import { useEffect, useState } from "react";

/** 16px favicon with a glyph fallback when the image is missing or fails. */
export function Favicon({ src, seed }: { src: string | null; seed: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);

  if (src === null || src.length === 0 || failed) {
    const letter = seed.replace(/^www\./, "").charAt(0).toUpperCase() || "•";
    return (
      <span className="grid size-4 shrink-0 place-items-center rounded-[4px] bg-ink/8 text-[9px] font-semibold text-muted">
        {letter}
      </span>
    );
  }
  return (
    <img
      src={src}
      alt=""
      className="size-4 shrink-0 rounded-[4px]"
      draggable={false}
      onError={() => setFailed(true)}
    />
  );
}

export function googleFavicon(domain: string): string {
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=32`;
}
