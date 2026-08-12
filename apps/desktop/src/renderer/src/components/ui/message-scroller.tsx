/**
 * shadcn/ui MessageScroller (2026-06 chat components), ported to Suma's
 * tokens. The behavior is NOT reimplemented: this wraps the real headless
 * primitives from `@shadcn/react/message-scroller`, which own the parts a
 * chat scroll container gets wrong — pinning to the newest turn while a reply
 * streams, releasing that pin the moment the user scrolls away, anchoring on
 * a turn rather than a pixel offset, and driving the jump-to-end button's
 * active state.
 *
 * Upstream's `.cn-message-scroller-*` classes come from a shadcn style sheet;
 * here they are folded into the wrappers against Suma's palette. Two of its
 * utilities have no equivalent in this codebase and are dropped rather than
 * faked: `scroll-fade-*` (masked edges) and `scrollbar-thin` — Suma styles
 * its scrollbars globally in styles.css.
 */

import { ArrowDown, ArrowUp } from "lucide-react";
import {
  MessageScroller as MessageScrollerPrimitive,
  useMessageScroller,
  useMessageScrollerScrollable,
  useMessageScrollerVisibility,
} from "@shadcn/react/message-scroller";
import { cn } from "../../lib/cn";
import { Button } from "./button";

function MessageScrollerProvider(
  props: React.ComponentProps<typeof MessageScrollerPrimitive.Provider>,
) {
  return <MessageScrollerPrimitive.Provider {...props} />;
}

function MessageScroller({
  className,
  ...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Root>) {
  return (
    <MessageScrollerPrimitive.Root
      data-slot="message-scroller"
      className={cn(
        "group/message-scroller relative flex size-full min-h-0 flex-col overflow-hidden",
        className,
      )}
      {...props}
    />
  );
}

function MessageScrollerViewport({
  className,
  ...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Viewport>) {
  return (
    <MessageScrollerPrimitive.Viewport
      data-slot="message-scroller-viewport"
      className={cn(
        "size-full min-h-0 min-w-0 overflow-y-auto overscroll-contain outline-none",
        className,
      )}
      {...props}
    />
  );
}

function MessageScrollerContent({
  className,
  ...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Content>) {
  return (
    <MessageScrollerPrimitive.Content
      data-slot="message-scroller-content"
      className={cn("flex h-max min-h-full flex-col gap-4", className)}
      {...props}
    />
  );
}

function MessageScrollerItem({
  className,
  scrollAnchor = false,
  ...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Item>) {
  return (
    <MessageScrollerPrimitive.Item
      data-slot="message-scroller-item"
      scrollAnchor={scrollAnchor}
      className={cn("min-w-0 shrink-0", className)}
      {...props}
    />
  );
}

/**
 * Jump-to-end affordance. The primitive drives `data-active`; it stays mounted
 * and animates out so the button does not pop in and out of the layout.
 */
function MessageScrollerButton({
  direction = "end",
  className,
  children,
  ...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Button>) {
  return (
    <MessageScrollerPrimitive.Button
      data-slot="message-scroller-button"
      data-direction={direction}
      direction={direction}
      className={cn(
        "absolute left-1/2 z-10 -translate-x-1/2 shadow-pop transition-[translate,scale,opacity] duration-200 data-[active=false]:pointer-events-none data-[active=false]:scale-95 data-[active=false]:opacity-0 data-[active=true]:scale-100 data-[active=true]:opacity-100",
        direction === "end"
          ? "bottom-3 data-[active=false]:translate-y-full"
          : "top-3 data-[active=false]:-translate-y-full",
        className,
      )}
      render={<Button variant="secondary" size="icon" className="rounded-full" />}
      {...props}
    >
      {children ?? (
        <>
          {direction === "end" ? (
            <ArrowDown className="size-3" aria-hidden="true" />
          ) : (
            <ArrowUp className="size-3" aria-hidden="true" />
          )}
          <span className="sr-only">
            {direction === "end" ? "Scroll to newest" : "Scroll to start"}
          </span>
        </>
      )}
    </MessageScrollerPrimitive.Button>
  );
}

export {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScroller,
  useMessageScrollerScrollable,
  useMessageScrollerVisibility,
};
