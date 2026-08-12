import { Reveal } from "@/components/reveal";
import { cn } from "@/lib/utils";

export function Shell({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mx-auto w-full max-w-[92rem] px-5 sm:px-8", className)}>
      {children}
    </div>
  );
}

/**
 * A band's opening: an index and a name over a large headline, with an
 * optional action pinned to the right. Replaces the ruled running-head row —
 * the headline carries the band now, not a hairline.
 */
export function SectionHead({
  index,
  label,
  title,
  action,
}: {
  index: string;
  label: string;
  title: React.ReactNode;
  action?: { href: string; label: string };
}) {
  return (
    <Reveal className="flex flex-col gap-8 pb-10 pt-20 sm:pt-24 lg:flex-row lg:items-end lg:justify-between lg:pb-14 lg:pt-32">
      <div>
        <p className="label">
          <span className="text-royal">{index}</span>
          <span className="px-2 opacity-30">—</span>
          {label}
        </p>
        <h2 className="display mt-5 max-w-[18ch] text-[clamp(2.1rem,4.4vw,3.75rem)] leading-[1.02]">
          {title}
        </h2>
      </div>

      {action ? (
        <a
          href={action.href}
          data-pixel="control"
          className="group inline-flex shrink-0 items-center gap-2.5 self-start rounded-full bg-surface px-6 py-3.5 text-[0.9375rem] font-medium transition-colors hover:bg-ink hover:text-paper lg:self-auto"
        >
          {action.label}
          <span
            aria-hidden
            className="transition-transform duration-300 group-hover:translate-x-1"
          >
            →
          </span>
        </a>
      ) : null}
    </Reveal>
  );
}

/**
 * The page's one content surface: a filled, rounded panel. `tone` picks the
 * ground it carries — the page's own, a step off it, the accent, or ink.
 *
 * `data-pixel` is what the cursor field reads: a panel is solid to it, and
 * meeting one lights its edge. See `@/components/pixel-field`.
 */
export function Card({
  tone = "surface",
  className,
  children,
}: {
  tone?: "surface" | "raised" | "royal" | "ink";
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      data-pixel="card"
      className={cn(
        "rounded-xl p-7 sm:rounded-2xl sm:p-9",
        tone === "surface" && "bg-surface",
        tone === "raised" && "bg-paper-raised",
        tone === "royal" && "bg-royal text-paper",
        tone === "ink" && "bg-ink text-paper",
        className,
      )}
    >
      {children}
    </div>
  );
}
