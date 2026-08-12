/**
 * shadcn/ui Bubble (https://ui.shadcn.com/docs/changelog/2026-06-chat-components),
 * ported to Suma's surface tokens the same way ui/button.tsx was.
 *
 * Structure, slots, and prop API are the upstream ones verbatim — a bubble is
 * a column whose `data-slot="bubble-content"` child carries the fill, which is
 * what lets one variant class restyle content it does not own. What changed is
 * the palette: upstream's `.cn-bubble-variant-*` rules live in a shadcn style
 * sheet keyed to --primary/--muted/--border, none of which exist here, so each
 * variant is re-expressed against the two-knob OKLCH ladder (styles.css).
 */

import { cn } from "../../lib/cn";

type BubbleVariant =
  | "default"
  | "secondary"
  | "muted"
  | "tinted"
  | "outline"
  | "ghost"
  | "destructive";

/** Each variant styles the CONTENT child, never the bubble box itself. */
const VARIANT: Record<BubbleVariant, string> = {
  default: "*:data-[slot=bubble-content]:bg-accent *:data-[slot=bubble-content]:text-bg",
  secondary: "*:data-[slot=bubble-content]:bg-ink/10 *:data-[slot=bubble-content]:text-text",
  muted: "*:data-[slot=bubble-content]:bg-ink/6 *:data-[slot=bubble-content]:text-text",
  tinted: "*:data-[slot=bubble-content]:bg-accent/15 *:data-[slot=bubble-content]:text-text",
  outline:
    "*:data-[slot=bubble-content]:border-hairline *:data-[slot=bubble-content]:bg-ink/3 *:data-[slot=bubble-content]:text-text",
  ghost:
    "*:data-[slot=bubble-content]:rounded-none *:data-[slot=bubble-content]:bg-transparent *:data-[slot=bubble-content]:p-0 *:data-[slot=bubble-content]:text-text",
  destructive:
    "*:data-[slot=bubble-content]:bg-danger/15 *:data-[slot=bubble-content]:text-danger",
};

function BubbleGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="bubble-group"
      className={cn("flex min-w-0 flex-col gap-2", className)}
      {...props}
    />
  );
}

function Bubble({
  variant = "default",
  align = "start",
  className,
  ...props
}: React.ComponentProps<"div"> & {
  variant?: BubbleVariant;
  align?: "start" | "end";
}) {
  return (
    <div
      data-slot="bubble"
      data-variant={variant}
      data-align={align}
      className={cn(
        "group/bubble relative flex w-fit min-w-0 max-w-[92%] flex-col gap-1 data-[align=end]:self-end data-[variant=ghost]:max-w-full group-data-[align=end]/message:self-end",
        VARIANT[variant],
        className,
      )}
      {...props}
    />
  );
}

function BubbleContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="bubble-content"
      className={cn(
        "w-fit max-w-full min-w-0 overflow-hidden rounded-xl border border-transparent px-2.5 py-1.5 text-[12.5px] leading-relaxed break-words group-data-[align=end]/bubble:self-end",
        className,
      )}
      {...props}
    />
  );
}

/** Overlapping chip rail (reactions, inline actions) pinned to a bubble edge. */
function BubbleReactions({
  side = "bottom",
  align = "end",
  className,
  ...props
}: React.ComponentProps<"div"> & {
  align?: "start" | "end";
  side?: "top" | "bottom";
}) {
  return (
    <div
      data-slot="bubble-reactions"
      data-align={align}
      data-side={side}
      className={cn(
        "absolute z-10 flex w-fit shrink-0 items-center justify-center gap-1 rounded-full bg-raised px-1.5 py-0.5 text-[11px] ring-2 ring-chrome",
        side === "top" ? "top-0 -translate-y-3/4" : "bottom-0 translate-y-3/4",
        align === "start" ? "left-3" : "right-3",
        className,
      )}
      {...props}
    />
  );
}

export { Bubble, BubbleContent, BubbleGroup, BubbleReactions, type BubbleVariant };
