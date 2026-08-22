import Link from "next/link";

export function GalaMark({
  compact = false,
  inverted = false,
  showGlyph = true,
  suffix,
}: {
  compact?: boolean;
  inverted?: boolean;
  showGlyph?: boolean;
  suffix?: string;
}) {
  const label = suffix ? `Gala.${suffix}` : "Gala";

  return (
    <Link
      href="/"
      aria-label={`${label} home`}
      className={`group inline-flex items-center gap-2.5 ${inverted ? "text-white" : "text-ink"}`}
    >
      {showGlyph && (
        <span
          className={`relative grid size-9 place-items-center rounded-full text-sm font-semibold transition-transform duration-300 group-hover:-rotate-6 ${
            inverted ? "bg-white text-violet" : "bg-ink text-white"
          }`}
        >
          G
          <span
            className={`absolute right-0 top-0 size-2.5 rounded-full border-2 bg-coral ${inverted ? "border-violet" : "border-cream"}`}
          />
        </span>
      )}
      {!compact && (
        <span
          className={`font-display font-bold leading-none tracking-[-0.05em] ${showGlyph ? "text-[2rem]" : "text-[2.5rem] sm:text-[2.75rem]"}`}
        >
          Gala
          {suffix && (
            <span className="font-light tracking-[-0.035em]">.{suffix}</span>
          )}
        </span>
      )}
    </Link>
  );
}
