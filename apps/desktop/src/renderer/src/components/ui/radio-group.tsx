/**
 * shadcn-style radio group
 * (https://ui.shadcn.com/docs/components/base/radio-group) on the Base UI
 * primitives, restyled with Suma's surface tokens.
 *
 * Base UI owns the roving-focus and arrow-key behavior a `role="radiogroup"`
 * is supposed to have, which the hand-rolled `sr-only` inputs it replaces did
 * not: those were reachable only by tabbing through every option.
 */

import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group";
import { cn } from "../../lib/cn";

/** Renders a plain `<div role="radiogroup">`; re-exported as-is for its generics. */
const RadioGroup = RadioGroupPrimitive;

function RadioGroupItem({
  className,
  ...props
}: Omit<React.ComponentProps<typeof RadioPrimitive.Root>, "className"> & {
  className?: string;
}) {
  return (
    <RadioPrimitive.Root
      data-slot="radio-group-item"
      className={cn(
        "grid size-3.5 shrink-0 cursor-pointer place-items-center rounded-full border border-ink/25 transition-colors outline-none",
        "data-checked:border-accent",
        "focus-visible:ring-2 focus-visible:ring-accent/40",
        "data-disabled:cursor-not-allowed data-disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <RadioPrimitive.Indicator className="size-1.5 rounded-full bg-accent data-unchecked:hidden" />
    </RadioPrimitive.Root>
  );
}

export { RadioGroup, RadioGroupItem };
