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
    <div className={cn("mx-auto w-full max-w-[90rem] px-5 sm:px-8", className)}>
      {children}
    </div>
  );
}

/**
 * A band's opening, set like a magazine running head: a hairline rule across
 * the page, the section name and index on it, and the headline in the display
 * serif underneath. The rule is what divides the page — sections themselves
 * carry no surface.
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
    <Reveal className="border-t pt-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-8 gap-y-2">
        <p className="label">
          <span className="text-foreground">{label}</span>
          <span className="px-2 opacity-40">/</span>
          {index}
        </p>
        {action ? (
          <a
            href={action.href}
            className="group text-[0.9375rem] text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
          >
            {action.label}
            <span
              aria-hidden
              className="ml-2 inline-block transition-transform duration-300 group-hover:translate-x-1"
            >
              →
            </span>
          </a>
        ) : null}
      </div>
      <h2 className="display mt-12 max-w-[22ch] text-[clamp(2.25rem,4.6vw,4.25rem)] leading-[1.03] sm:mt-16">
        {title}
      </h2>
    </Reveal>
  );
}

/**
 * The page's one content surface: a rounded panel with a hairline edge. Depth
 * comes from a change of ground, never from decoration — only `ink` gets to
 * be dark, and nothing gets to be loud.
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
      className={cn(
        "rounded-xl p-7 sm:rounded-2xl sm:p-9",
        tone === "surface" && "bg-surface",
        tone === "raised" && "border bg-paper-raised",
        tone === "royal" && "bg-royal text-paper",
        tone === "ink" && "bg-ink text-paper",
        className,
      )}
    >
      {children}
    </div>
  );
}
