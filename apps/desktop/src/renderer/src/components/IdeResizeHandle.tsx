import { useSumaStore } from "../store";
import { cn } from "../lib/cn";

/**
 * The IDE's splitter — the chat sidebar's ResizeHandle generalized to both
 * axes, because the terminal page needs one on a column edge (explorer) and
 * one on a row edge (terminal height). Same mechanism throughout: window-level
 * pointer listeners with rAF-coalesced moves, `setPaneResizing` so main raises
 * the chrome view above the tab views for the drag, a full-viewport cursor
 * shim, and a keyboard-steppable `role="separator"`.
 */

/** Keyboard resize step (arrows on the focused handle), in px. */
const KEY_STEP = 24;
/** Hit area around the 2px rule — the same forgiving seam the divider has. */
const HANDLE_W = 7;

interface IdeResizeHandleProps {
  /** "vertical" = a column edge (resizes a width); "horizontal" = a row edge. */
  orientation: "vertical" | "horizontal";
  value: number;
  min: number;
  max: number;
  defaultValue: number;
  ariaLabel: string;
  /** Map the pointer to the new size — geometry belongs to the caller. */
  compute: (clientX: number, clientY: number) => number;
  onChange: (px: number) => void;
}

export function IdeResizeHandle({
  orientation,
  value,
  min,
  max,
  defaultValue,
  ariaLabel,
  compute,
  onChange,
}: IdeResizeHandleProps) {
  const setPaneResizing = useSumaStore((s) => s.setPaneResizing);
  const resizing = useSumaStore((s) => s.paneResizing);
  const vertical = orientation === "vertical";

  const onPointerDown = (e: React.PointerEvent): void => {
    if (e.button !== 0) return;
    e.preventDefault();
    setPaneResizing(true);
    let raf = 0;
    let pendingX = e.clientX;
    let pendingY = e.clientY;
    const apply = (): void => {
      raf = 0;
      onChange(compute(pendingX, pendingY));
    };
    const onMove = (ev: PointerEvent): void => {
      pendingX = ev.clientX;
      pendingY = ev.clientY;
      if (raf === 0) raf = requestAnimationFrame(apply);
    };
    const onUp = (): void => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (raf !== 0) cancelAnimationFrame(raf);
      setPaneResizing(false);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    const grow = vertical ? "ArrowRight" : "ArrowUp";
    const shrink = vertical ? "ArrowLeft" : "ArrowDown";
    if (e.key !== grow && e.key !== shrink) return;
    e.preventDefault();
    onChange(value + (e.key === grow ? KEY_STEP : -KEY_STEP));
  };

  const cursor = vertical ? "cursor-col-resize" : "cursor-row-resize";
  return (
    <>
      <div
        role="separator"
        aria-orientation={orientation}
        aria-label={ariaLabel}
        aria-valuenow={value}
        aria-valuemin={min}
        aria-valuemax={max}
        tabIndex={0}
        title="Drag to resize — double-click to reset"
        style={
          vertical
            ? { width: HANDLE_W, right: -Math.round(HANDLE_W / 2) }
            : { height: HANDLE_W, top: -Math.round(HANDLE_W / 2) }
        }
        onPointerDown={onPointerDown}
        onDoubleClick={() => onChange(defaultValue)}
        onKeyDown={onKeyDown}
        className={cn(
          "group absolute z-10 outline-none",
          vertical ? "inset-y-0" : "inset-x-0",
          cursor,
        )}
      >
        <div
          className={cn(
            "rounded-full transition-colors",
            vertical ? "mx-auto h-full w-[2px]" : "my-auto h-[2px] w-full",
            resizing
              ? "bg-accent/60"
              : "bg-transparent group-hover:bg-ink/25 group-focus-visible:bg-accent/50",
          )}
        />
      </div>
      {resizing ? <div className={cn("fixed inset-0 z-50", cursor)} /> : null}
    </>
  );
}
