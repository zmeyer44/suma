import { Slot } from "radix-ui";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex shrink-0 select-none items-center justify-center gap-2 whitespace-nowrap text-sm font-medium transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-violet/25 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "rounded-[4px] bg-ink text-white shadow-sm hover:bg-coral",
        coral: "rounded-[4px] bg-coral text-white shadow-sm hover:bg-[#ff6b4a]",
        outline:
          "rounded-[4px] border border-line bg-transparent text-ink hover:bg-cream-bright",
        ghost: "rounded-[4px] text-inherit hover:bg-ink/5",
        white:
          "rounded-[4px] bg-white text-ink shadow-sm hover:bg-coral hover:text-white",
        bare: "",
      },
      size: {
        default: "h-10 px-5 py-2",
        sm: "h-8 px-3 text-xs",
        lg: "h-12 px-8 text-base",
        icon: "size-10",
        none: "h-auto p-0",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot.Root : "button";

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
