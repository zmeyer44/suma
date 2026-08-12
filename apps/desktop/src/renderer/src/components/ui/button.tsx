/**
 * shadcn-style button (https://ui.shadcn.com/docs/components/button) restyled
 * with Suma's surface tokens instead of the shadcn theme variables. Variant
 * fills follow the chrome's tonal language: solid accent for the one primary
 * action, translucent accent/white/danger washes for everything else.
 */

import { cn } from "../../lib/cn";

type ButtonVariant = "default" | "soft" | "secondary" | "outline" | "ghost" | "danger";
type ButtonSize = "sm" | "md" | "lg" | "xl" | "icon";

const VARIANT: Record<ButtonVariant, string> = {
  default:
    "bg-accent text-bg shadow-[inset_0_1px_0_rgb(255_255_255/0.25),0_1px_2px_rgb(0_0_0/0.2)] hover:bg-accent-bright active:bg-accent-deep",
  soft: "bg-accent/15 text-accent hover:bg-accent/25 active:bg-accent/30",
  secondary: "bg-ink/7 text-text hover:bg-ink/12 active:bg-ink/15",
  outline: "border border-ink/12 bg-ink/3 text-text hover:border-ink/25 hover:bg-ink/8",
  ghost: "text-muted hover:bg-ink/8 hover:text-text",
  danger: "bg-danger/15 text-danger hover:bg-danger/25 active:bg-danger/30",
};

const SIZE: Record<ButtonSize, string> = {
  sm: "h-6 gap-1 rounded-md px-2 text-[11px]",
  md: "h-7 gap-1.5 rounded-lg px-3 text-[12px]",
  lg: "h-8 gap-1.5 rounded-[9px] px-3.5 text-[12.5px]",
  /* Full-window surfaces only (onboarding): chrome-sized buttons look lost
     when nothing around them is chrome. */
  xl: "h-9 gap-2 rounded-[10px] px-4 text-[13px]",
  icon: "size-6 rounded-md",
};

function Button({
  variant = "default",
  size = "md",
  type = "button",
  className,
  ...props
}: React.ComponentProps<"button"> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
}) {
  return (
    <button
      type={type}
      data-slot="button"
      className={cn(
        "no-drag inline-flex shrink-0 cursor-pointer items-center justify-center font-medium whitespace-nowrap outline-none transition-colors duration-100 focus-visible:ring-2 focus-visible:ring-accent/40 disabled:pointer-events-none disabled:opacity-40",
        VARIANT[variant],
        SIZE[size],
        className,
      )}
      {...props}
    />
  );
}

export { Button, type ButtonSize, type ButtonVariant };
