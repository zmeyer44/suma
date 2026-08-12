/**
 * shadcn-style input (https://ui.shadcn.com/docs/components/base/input) on the
 * Base UI primitive, restyled with Suma's surface tokens.
 *
 * Sizes mirror Button's scale, so a field and the button beside it are the
 * same height without either call site guessing at a number — which is how the
 * app ended up with four near-identical field constants (`FIELD`,
 * `FIELD_CLASS`, `INPUT_CLASS`, and a handful of one-offs) that disagreed by a
 * pixel or two.
 *
 * `variant="bare"` is for the field that IS its container — the command bar,
 * the URL bar, the search rows. Those draw the border, the focus ring, and an
 * icon on a WRAPPER, so the control inside has to stay transparent and
 * ring-less; it still wants the shared caret, placeholder, and text tones.
 */

import { Input as InputPrimitive } from "@base-ui/react/input";
import { cn } from "../../lib/cn";

type FieldSize = "sm" | "md" | "lg" | "xl";
type FieldVariant = "default" | "bare";

/** Heights and text sizes shared by Input, Textarea, and the Select trigger. */
const FIELD_SIZE: Record<FieldSize, string> = {
  sm: "h-6 rounded-md px-1.5 text-[11px]",
  md: "h-7 rounded-lg px-2 text-[12px]",
  lg: "h-8 rounded-[9px] px-2.5 text-[12.5px]",
  /* Full-window surfaces only (onboarding), like Button's `xl`. */
  xl: "h-9 rounded-[10px] px-3 text-[13px]",
};

const FIELD_VARIANT: Record<FieldVariant, string> = {
  default:
    "border border-hairline bg-bg/70 focus:border-accent/60 focus:ring-2 focus:ring-accent/20",
  bare: "bg-transparent",
};

/**
 * No width here on purpose: `cn()` has no tailwind-merge, so a `w-full` base
 * and a `w-[240px]` override would be settled by Tailwind's source order
 * rather than by the call site. Width always belongs to the caller.
 */
const FIELD_BASE =
  "min-w-0 text-text caret-accent outline-none placeholder:text-faint disabled:cursor-not-allowed disabled:opacity-50";

function Input({
  size = "md",
  variant = "default",
  className,
  ...props
}: Omit<React.ComponentProps<typeof InputPrimitive>, "className" | "size"> & {
  size?: FieldSize;
  variant?: FieldVariant;
  /** Plain strings only — Base UI's state-function form is not needed here. */
  className?: string;
}) {
  return (
    <InputPrimitive
      data-slot="input"
      className={cn(
        FIELD_BASE,
        FIELD_VARIANT[variant],
        // A bare field is sized by the wrapper it sits in, so imposing a
        // height and a radius on it would fight that wrapper.
        variant === "default" && FIELD_SIZE[size],
        className,
      )}
      {...props}
    />
  );
}

export { FIELD_BASE, FIELD_SIZE, FIELD_VARIANT, Input, type FieldSize, type FieldVariant };
