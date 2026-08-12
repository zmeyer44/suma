/**
 * shadcn-style slider (https://ui.shadcn.com/docs/components/base/slider) on
 * the Base UI primitive, restyled with Suma's surface tokens. One of these,
 * shared by the audio scrubber and the speed/volume rows on the Voice & audio
 * page.
 *
 * It replaces an `<input type="range">` whose elapsed fill had to be painted
 * as an inline `linear-gradient` recomputed on every frame of playback, and
 * whose thumb could only be reached through `::-webkit-slider-thumb` — a rule
 * that is true in Electron and nowhere else. Here the fill is a real element.
 *
 * `onValueCommitted` is the part the native element never had: it fires when
 * the drag ENDS, which is exactly when a scrub should turn into a seek.
 *
 * The control keeps its padding at `py-1` so the row it sits in does not grow:
 * a bare 4px rail is a miserable drag target, but 12px still fits inside the
 * line box of the timestamp beside it.
 */

import { Slider as SliderPrimitive } from "@base-ui/react/slider";
import { cn } from "../../lib/cn";

function Slider({
  className,
  "aria-label": ariaLabel,
  ...props
}: Omit<React.ComponentProps<typeof SliderPrimitive.Root<number>>, "className"> & {
  className?: string;
}) {
  return (
    <SliderPrimitive.Root
      data-slot="slider"
      className={cn("data-disabled:opacity-50", className)}
      {...props}
    >
      <SliderPrimitive.Control className="flex w-full touch-none items-center py-1 select-none data-disabled:cursor-default">
        <SliderPrimitive.Track className="h-1 w-full rounded-full bg-ink/12 select-none">
          <SliderPrimitive.Indicator className="rounded-full bg-accent select-none" />
          <SliderPrimitive.Thumb
            aria-label={ariaLabel}
            className="size-2.5 cursor-pointer rounded-full bg-accent outline-none select-none has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent/40 data-disabled:cursor-default"
          />
        </SliderPrimitive.Track>
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  );
}

export { Slider };
