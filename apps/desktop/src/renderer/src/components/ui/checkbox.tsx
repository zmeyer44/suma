/**
 * shadcn-style checkbox (https://ui.shadcn.com/docs/components/base/checkbox)
 * on the Base UI primitive, restyled with Suma's surface tokens.
 *
 * The native checkbox is the one control that ignores the palette outright: it
 * paints a stark white slab with a system-blue fill on whatever surface it
 * lands on. The onboarding wizard worked around that with an `sr-only` input
 * behind a `peer-checked:` box; this is that trick, done once, with the focus
 * and disabled states the hand-rolled version never had.
 */

import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";
import { Check } from "lucide-react";
import { cn } from "../../lib/cn";

function Checkbox({
  className,
  ...props
}: Omit<React.ComponentProps<typeof CheckboxPrimitive.Root>, "className"> & {
  className?: string;
}) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "grid size-4 shrink-0 cursor-pointer place-items-center rounded-[5px] border border-ink/25 bg-ink/5 text-bg transition-colors outline-none",
        "data-checked:border-accent data-checked:bg-accent",
        "focus-visible:ring-2 focus-visible:ring-accent/40",
        "data-disabled:cursor-not-allowed data-disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator className="flex data-unchecked:hidden">
        <Check className="size-2.5" strokeWidth={3} aria-hidden="true" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
