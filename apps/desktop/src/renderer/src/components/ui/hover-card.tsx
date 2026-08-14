import { PreviewCard as PreviewCardPrimitive } from "@base-ui/react/preview-card";
import { cn } from "../../lib/cn";

/**
 * shadcn-style hover card (https://ui.shadcn.com/docs/components/base/hover-card)
 * on the Base UI preview-card primitive, restyled with Suma's surface tokens
 * instead of the shadcn theme variables. Opens on hover/focus rather than click;
 * the popup stays open while the pointer is inside it, so the content can hold
 * buttons. Enter/exit motion lives in `.hover-card-pop` (styles.css).
 */

function HoverCard(props: React.ComponentProps<typeof PreviewCardPrimitive.Root>) {
  return <PreviewCardPrimitive.Root data-slot="hover-card" {...props} />;
}

// Closing is immediate: Base UI arms a `safePolygon()` on the trigger, so the
// pointer can still travel the gap into the popup without a close delay to
// cover it.
function HoverCardTrigger({
  delay = 200,
  closeDelay = 0,
  ...props
}: React.ComponentProps<typeof PreviewCardPrimitive.Trigger>) {
  return (
    <PreviewCardPrimitive.Trigger
      data-slot="hover-card-trigger"
      delay={delay}
      closeDelay={closeDelay}
      {...props}
    />
  );
}

function HoverCardContent({
  className,
  align = "center",
  side = "bottom",
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof PreviewCardPrimitive.Popup> & {
  align?: React.ComponentProps<typeof PreviewCardPrimitive.Positioner>["align"];
  side?: React.ComponentProps<typeof PreviewCardPrimitive.Positioner>["side"];
  sideOffset?: number;
}) {
  return (
    <PreviewCardPrimitive.Portal>
      <PreviewCardPrimitive.Positioner align={align} side={side} sideOffset={sideOffset} className="z-50">
        <PreviewCardPrimitive.Popup
          data-slot="hover-card-content"
          // Base UI lets `className` be a function of the popup's state, so the
          // caller's value is resolved against that state before it is joined.
          className={(state) =>
            cn(
              "hover-card-pop w-64 rounded-xl border border-float-edge bg-raised p-3 text-text shadow-pop outline-none",
              typeof className === "function" ? className(state) : className,
            )
          }
          {...props}
        />
      </PreviewCardPrimitive.Positioner>
    </PreviewCardPrimitive.Portal>
  );
}

export { HoverCard, HoverCardContent, HoverCardTrigger };
