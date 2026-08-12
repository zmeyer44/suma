/**
 * shadcn-style select (https://ui.shadcn.com/docs/components/base/select) on
 * the Base UI primitive, restyled with Suma's surface tokens.
 *
 * Why not the native `<select>` it replaces: its popup is drawn by AppKit, not
 * by the renderer, so it is the one surface in the app the two-knob palette
 * cannot reach — a themed chrome that opens a stock system menu. The trigger
 * could be styled; the list never could. This one is ours end to end, and it
 * matches the height of the Input beside it because both read the same size
 * scale.
 */

import { Select as SelectPrimitive, type SelectRootProps } from "@base-ui/react/select";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "../../lib/cn";
import { FIELD_VARIANT, type FieldSize } from "./input";

/** Input's sizes, re-cut for a trigger: the chevron eats the right padding. */
const TRIGGER_SIZE: Record<FieldSize, string> = {
  sm: "h-6 gap-1 rounded-md pr-1 pl-1.5 text-[11px]",
  md: "h-7 gap-1.5 rounded-lg pr-1.5 pl-2 text-[12px]",
  lg: "h-8 gap-1.5 rounded-[9px] pr-2 pl-2.5 text-[12.5px]",
  xl: "h-9 gap-2 rounded-[10px] pr-2.5 pl-3 text-[13px]",
};

/**
 * Renders no element of its own; it exists here only to narrow the change
 * handler. Base UI types the new value as `Value | null`, because a select MAY
 * carry an item whose value is null — none of Suma's do, so the null is
 * dropped once here instead of at every call site, each of which would be
 * guarding against a case it cannot produce.
 */
function Select<Value>({
  onValueChange,
  ...props
}: Omit<SelectRootProps<Value>, "onValueChange"> & {
  onValueChange?: (value: Value) => void;
}) {
  return (
    <SelectPrimitive.Root
      onValueChange={(value) => {
        if (value !== null) onValueChange?.(value);
      }}
      {...props}
    />
  );
}

function SelectTrigger({
  size = "md",
  className,
  children,
  ...props
}: Omit<React.ComponentProps<typeof SelectPrimitive.Trigger>, "className"> & {
  size?: FieldSize;
  className?: string;
}) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      className={cn(
        "no-drag inline-flex cursor-pointer items-center justify-between text-text outline-none select-none",
        FIELD_VARIANT.default,
        TRIGGER_SIZE[size],
        "hover:not-data-disabled:border-ink/25 data-disabled:cursor-not-allowed data-disabled:opacity-50",
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon className="shrink-0 text-faint">
        <ChevronDown className="size-3" aria-hidden="true" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

function SelectValue({
  className,
  ...props
}: Omit<React.ComponentProps<typeof SelectPrimitive.Value>, "className"> & {
  className?: string;
}) {
  return (
    <SelectPrimitive.Value
      data-slot="select-value"
      className={cn("truncate data-placeholder:text-faint", className)}
      {...props}
    />
  );
}

/**
 * The popup. `alignItemWithTrigger` is off: Base UI's default lifts the popup
 * so the SELECTED row lands on the trigger (AppKit's behavior), which inside a
 * settings card reads as the page jumping rather than as a menu opening.
 */
function SelectContent({
  className,
  align = "start",
  side = "bottom",
  sideOffset = 4,
  children,
  ...props
}: Omit<React.ComponentProps<typeof SelectPrimitive.Popup>, "className"> & {
  align?: React.ComponentProps<typeof SelectPrimitive.Positioner>["align"];
  side?: React.ComponentProps<typeof SelectPrimitive.Positioner>["side"];
  sideOffset?: number;
  className?: string;
}) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Positioner
        align={align}
        side={side}
        sideOffset={sideOffset}
        alignItemWithTrigger={false}
        className="z-50 outline-none"
      >
        <SelectPrimitive.Popup
          data-slot="select-content"
          className={cn(
            "animate-overlay-in min-w-[var(--anchor-width)] origin-[var(--transform-origin)] rounded-xl border border-hairline bg-raised p-1 text-text shadow-pop outline-none",
            className,
          )}
          {...props}
        >
          <SelectPrimitive.List className="max-h-[min(20rem,var(--available-height))] scroll-py-1 overflow-y-auto">
            {children}
          </SelectPrimitive.List>
        </SelectPrimitive.Popup>
      </SelectPrimitive.Positioner>
    </SelectPrimitive.Portal>
  );
}

function SelectItem({
  className,
  children,
  ...props
}: Omit<React.ComponentProps<typeof SelectPrimitive.Item>, "className"> & {
  className?: string;
}) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        "grid cursor-pointer grid-cols-[0.75rem_1fr] items-center gap-1.5 rounded-lg px-2 py-1.5 text-[12px] text-muted outline-none select-none",
        "data-highlighted:bg-ink/8 data-highlighted:text-text data-selected:text-text",
        "data-disabled:pointer-events-none data-disabled:opacity-40",
        className,
      )}
      {...props}
    >
      <SelectPrimitive.ItemIndicator className="col-start-1 text-accent">
        <Check className="size-3" aria-hidden="true" />
      </SelectPrimitive.ItemIndicator>
      <SelectPrimitive.ItemText className="col-start-2 truncate">
        {children}
      </SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  );
}

function SelectGroup(props: React.ComponentProps<typeof SelectPrimitive.Group>) {
  return <SelectPrimitive.Group data-slot="select-group" {...props} />;
}

function SelectGroupLabel({
  className,
  ...props
}: Omit<React.ComponentProps<typeof SelectPrimitive.GroupLabel>, "className"> & {
  className?: string;
}) {
  return (
    <SelectPrimitive.GroupLabel
      data-slot="select-group-label"
      className={cn(
        "px-2 py-1 text-[10px] font-semibold tracking-[0.08em] text-faint uppercase",
        className,
      )}
      {...props}
    />
  );
}

function SelectSeparator({
  className,
  ...props
}: Omit<React.ComponentProps<typeof SelectPrimitive.Separator>, "className"> & {
  className?: string;
}) {
  return (
    <SelectPrimitive.Separator
      data-slot="select-separator"
      className={cn("my-1 h-px bg-hairline", className)}
      {...props}
    />
  );
}

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
};
