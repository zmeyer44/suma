import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { cn } from "../../lib/cn";

/**
 * shadcn-style popover (https://ui.shadcn.com/docs/components/base/popover)
 * on the Base UI primitive, restyled with Suma's surface tokens instead of
 * the shadcn theme variables.
 */

function Popover(props: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />;
}

function PopoverTrigger(props: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}

function PopoverContent({
  className,
  align = "center",
  side = "bottom",
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Popup> & {
  align?: React.ComponentProps<typeof PopoverPrimitive.Positioner>["align"];
  side?: React.ComponentProps<typeof PopoverPrimitive.Positioner>["side"];
  sideOffset?: number;
}) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner align={align} side={side} sideOffset={sideOffset} className="z-50">
        <PopoverPrimitive.Popup
          data-slot="popover-content"
          initialFocus={false}
          // Base UI lets `className` be a function of the popup's state, so the
          // caller's value is resolved against that state before it is joined.
          className={(state) =>
            cn(
              "animate-overlay-in w-64 rounded-xl border border-hairline bg-raised p-3 text-text shadow-pop outline-none",
              typeof className === "function" ? className(state) : className,
            )
          }
          {...props}
        />
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  );
}

export { Popover, PopoverContent, PopoverTrigger };
