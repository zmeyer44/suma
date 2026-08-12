/**
 * shadcn/ui Marker (2026-06 chat components), ported to Suma's tokens.
 *
 * The non-message rows of a thread: streaming state, tool activity, date
 * breaks, errors. `separator` grows a hairline out of both sides of its
 * content; `border` underlines the row instead.
 */

import { cn } from "../../lib/cn";

type MarkerVariant = "default" | "separator" | "border";

const VARIANT: Record<MarkerVariant, string> = {
  default: "",
  separator:
    "before:mr-1 before:h-px before:min-w-0 before:flex-1 before:bg-hairline after:ml-1 after:h-px after:min-w-0 after:flex-1 after:bg-hairline",
  border: "border-b border-hairline pb-2",
};

function Marker({
  className,
  variant = "default",
  children,
  ...props
}: React.ComponentProps<"div"> & { variant?: MarkerVariant }) {
  return (
    <div
      {...props}
      data-slot="marker"
      data-variant={variant}
      className={cn(
        "group/marker relative flex min-h-4 w-full items-center gap-1.5 text-left text-[11px] text-faint",
        VARIANT[variant],
        className,
      )}
    >
      {children}
    </div>
  );
}

function MarkerIcon({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="marker-icon"
      aria-hidden="true"
      className={cn("flex size-3 shrink-0 items-center justify-center", className)}
      {...props}
    />
  );
}

function MarkerContent({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="marker-content"
      className={cn(
        "min-w-0 break-words group-data-[variant=separator]/marker:flex-none group-data-[variant=separator]/marker:text-center",
        className,
      )}
      {...props}
    />
  );
}

export { Marker, MarkerContent, MarkerIcon, type MarkerVariant };
