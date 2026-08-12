/**
 * shadcn-style textarea (https://ui.shadcn.com/docs/components/base/textarea)
 * restyled with Suma's surface tokens. Base UI ships no textarea primitive —
 * shadcn's is a styled native element too — so this shares Input's chrome
 * rather than its own, and swaps the fixed height for `rows`.
 *
 * `variant="bare"` behaves as it does on Input: the chat composer draws its
 * own border and focus ring around the control and a send button.
 */

import { cn } from "../../lib/cn";
import { FIELD_BASE, FIELD_VARIANT, type FieldVariant } from "./input";

function Textarea({
  variant = "default",
  className,
  ...props
}: React.ComponentProps<"textarea"> & { variant?: FieldVariant }) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        FIELD_BASE,
        FIELD_VARIANT[variant],
        variant === "default" && "rounded-lg px-2 py-1.5 text-[12px] leading-relaxed",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
