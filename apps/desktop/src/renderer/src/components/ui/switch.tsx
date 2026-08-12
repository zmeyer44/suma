/**
 * The settings toggle: a 34×20 track that fills with the accent when on.
 * Shared by every panel-style row (Settings, Appearance) so the chrome has
 * exactly one on/off affordance. The terminal's inline Job Mode switch is
 * deliberately its own smaller, ok-colored variant.
 */

import { cn } from "../../lib/cn";

export function Switch({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative h-[20px] w-[34px] rounded-full transition-colors",
        checked ? "bg-accent" : "bg-ink/12",
        disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
      )}
    >
      <span
        className={cn(
          "absolute top-[2px] size-[16px] rounded-full bg-white shadow transition-all",
          checked ? "left-[16px]" : "left-[2px]",
        )}
      />
    </button>
  );
}
