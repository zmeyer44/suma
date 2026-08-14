import { Toast as ToastPrimitive } from "@base-ui/react/toast";
import type { LucideIcon } from "lucide-react";
import {
  CircleCheck,
  CircleX,
  Info,
  LoaderCircle,
  TriangleAlert,
  X,
} from "lucide-react";
import { cn } from "../../lib/cn";
import { Button } from "./button";

/**
 * shadcn-style toast (https://ui.shadcn.com/docs/components/base/toast) on the
 * Base UI primitive, restyled with Suma's surface tokens instead of the
 * shadcn theme variables. The stacking behaviour is the registry component's
 * verbatim: toasts pile bottom-anchored with a peek offset and a downscale per
 * layer, and the pile expands on hover/focus. Only the CSS-var transform math
 * is load-bearing — everything visual (surface, type scale, icons, buttons) is
 * Suma's.
 *
 * Two deliberate departures from the registry:
 *
 *  - No Toast.Portal. The viewport is rendered inside App's bottom-left
 *    notification column rather than portalled to a corner of <body>: the
 *    chrome view renders BELOW the tab WebContentsViews, so a card anchored
 *    over the content hole is invisible whenever a tab is open. The column is
 *    the one place passive cards can live (see App.tsx), and keeping the
 *    viewport in its flow means toasts stack WITH the bypass cards
 *    instead of on top of them.
 *  - Swipe-to-dismiss goes down or LEFT, not down/right — the pile sits
 *    against the window's left edge, so that is the direction off-screen.
 *
 * `toast` is a manager created outside React, so non-component code can raise
 * one: the store's pushToast is the single caller (store.ts).
 */

const toast = ToastPrimitive.createToastManager();

/** The types the icon strip below knows how to draw. */
type ToastType = "success" | "info" | "warning" | "error" | "loading";

/**
 * Per-type tone, in the onboarding screen's vocabulary (OnboardingWizard.tsx):
 * a tinted icon tile over a wash of the same semantic color, plus the corner
 * bloom the brand rail uses — one radial gradient out of the top-left, held
 * low enough that it reads as a tint on the raised surface rather than a
 * second fill. An untyped toast (Suma's default shape) takes neither: it
 * stays the plain card it was.
 */
const TONE: Record<ToastType, { chip: string; bloom: string }> = {
  success: {
    chip: "bg-ok/15 text-ok",
    bloom:
      "before:bg-[radial-gradient(120%_120%_at_0%_0%,var(--color-ok)_0%,transparent_62%)]",
  },
  info: {
    chip: "bg-accent/15 text-accent",
    bloom:
      "before:bg-[radial-gradient(120%_120%_at_0%_0%,var(--color-accent)_0%,transparent_62%)]",
  },
  warning: {
    chip: "bg-warn/15 text-warn",
    bloom:
      "before:bg-[radial-gradient(120%_120%_at_0%_0%,var(--color-warn)_0%,transparent_62%)]",
  },
  error: {
    chip: "bg-danger/15 text-danger",
    bloom:
      "before:bg-[radial-gradient(120%_120%_at_0%_0%,var(--color-danger)_0%,transparent_62%)]",
  },
  loading: {
    chip: "bg-ink/6 text-muted",
    bloom: "",
  },
};

function toneFor(type: string | undefined): { chip: string; bloom: string } {
  return TONE[type as ToastType] ?? { chip: "", bloom: "" };
}

/**
 * Base UI also accepts a `(state) => string` callback for className; cn()
 * takes strings. None of these parts need the callback form, so narrow it
 * away rather than teaching cn() a shape it is never handed.
 */
type WithClassName<P> = Omit<P, "className"> & { className?: string };

function ToastProvider(props: ToastPrimitive.Provider.Props) {
  return <ToastPrimitive.Provider {...props} />;
}

function ToastViewport({
  className,
  ...props
}: WithClassName<ToastPrimitive.Viewport.Props>) {
  return (
    <ToastPrimitive.Viewport
      data-slot="toast-viewport"
      // Height follows the frontmost toast (Base UI sets the var here), so an
      // empty viewport collapses to nothing and the cards above it settle back
      // down. The toasts themselves are absolutely placed within it.
      className={cn(
        "pointer-events-none relative w-full outline-none",
        "min-h-[var(--toast-frontmost-height,0px)] transition-[min-height] duration-250 ease-[cubic-bezier(0.22,1,0.36,1)]",
        className,
      )}
      {...props}
    />
  );
}

function Toast({
  className,
  swipeDirection = ["down", "left"],
  ...props
}: WithClassName<ToastPrimitive.Root.Props>) {
  return (
    <ToastPrimitive.Root
      data-slot="toast"
      data-testid="toast"
      swipeDirection={swipeDirection}
      className={cn(
        "group/toast pointer-events-auto absolute inset-x-0 bottom-0 z-[calc(1000-var(--toast-index))] origin-bottom rounded-xl border border-float-edge bg-raised text-text shadow-pop will-change-transform outline-none select-none focus-visible:border-accent/50 focus-visible:ring-2 focus-visible:ring-accent/40",
        // The tone bloom (TONE.bloom supplies the gradient; nothing paints
        // without it). Behind the content, above the fill, clipped to the
        // card's own radius so the corners stay clean.
        "before:pointer-events-none before:absolute before:inset-0 before:rounded-[inherit] before:opacity-[0.09] before:content-['']",
        "[--gap:0.5rem] [--height:var(--toast-frontmost-height,var(--toast-height))] [--offset-y:calc(var(--toast-offset-y)*-1+calc(var(--toast-index)*var(--gap)*-1)+var(--toast-swipe-movement-y))] [--peek:0.5rem] [--scale:calc(max(0,1-(var(--toast-index)*0.1)))] [--shrink:calc(1-var(--scale))]",
        "h-(--height) [transform:translateX(var(--toast-swipe-movement-x))_translateY(calc(var(--toast-swipe-movement-y)-(var(--toast-index)*var(--peek))-(var(--shrink)*var(--height))))_scale(var(--scale))] [transition:transform_500ms_cubic-bezier(0.22,1,0.36,1),opacity_500ms,height_150ms] data-ending-style:opacity-0",
        // Bridges the gap between stacked cards so the pile stays hovered.
        "after:absolute after:top-full after:left-0 after:h-[calc(var(--gap)+1px)] after:w-full after:content-['']",
        "data-expanded:h-(--toast-height) data-expanded:[transform:translateX(var(--toast-swipe-movement-x))_translateY(var(--offset-y))]",
        "data-limited:opacity-0 data-starting-style:[transform:translateY(150%)]",
        "[&[data-ending-style]:not([data-limited]):not([data-swipe-direction])]:[transform:translateY(150%)]",
        "data-ending-style:data-[swipe-direction=down]:[transform:translateY(calc(var(--toast-swipe-movement-y)+150%))]",
        "data-ending-style:data-[swipe-direction=left]:[transform:translateX(calc(var(--toast-swipe-movement-x)-150%))_translateY(var(--offset-y))]",
        "data-ending-style:data-[swipe-direction=right]:[transform:translateX(calc(var(--toast-swipe-movement-x)+150%))_translateY(var(--offset-y))]",
        "data-ending-style:data-[swipe-direction=up]:[transform:translateY(calc(var(--toast-swipe-movement-y)-150%))]",
        "data-expanded:data-ending-style:data-[swipe-direction=down]:[transform:translateY(calc(var(--toast-swipe-movement-y)+150%))]",
        "data-expanded:data-ending-style:data-[swipe-direction=left]:[transform:translateX(calc(var(--toast-swipe-movement-x)-150%))_translateY(var(--offset-y))]",
        "data-expanded:data-ending-style:data-[swipe-direction=right]:[transform:translateX(calc(var(--toast-swipe-movement-x)+150%))_translateY(var(--offset-y))]",
        "data-expanded:data-ending-style:data-[swipe-direction=up]:[transform:translateY(calc(var(--toast-swipe-movement-y)-150%))]",
        className,
      )}
      {...props}
    />
  );
}

function ToastContent({
  className,
  ...props
}: WithClassName<ToastPrimitive.Content.Props>) {
  return (
    <ToastPrimitive.Content
      data-slot="toast-content"
      className={cn(
        "relative flex h-full items-start gap-2.5 overflow-hidden px-3 py-2.5",
        "transition-opacity duration-250 ease-[cubic-bezier(0.22,1,0.36,1)] data-behind:opacity-0 data-expanded:opacity-100",
        className,
      )}
      {...props}
    />
  );
}

function ToastTitle({
  className,
  ...props
}: WithClassName<ToastPrimitive.Title.Props>) {
  return (
    <ToastPrimitive.Title
      data-slot="toast-title"
      className={cn(
        "text-[12.5px] leading-snug font-semibold tracking-[-0.01em] text-text",
        className,
      )}
      {...props}
    />
  );
}

function ToastDescription({
  className,
  ...props
}: WithClassName<ToastPrimitive.Description.Props>) {
  return (
    <ToastPrimitive.Description
      data-slot="toast-description"
      className={cn("text-[12px] leading-[1.45] text-text", className)}
      {...props}
    />
  );
}

function ToastAction({
  className,
  render = <Button variant="outline" size="sm" />,
  ...props
}: WithClassName<ToastPrimitive.Action.Props>) {
  return (
    <ToastPrimitive.Action
      data-slot="toast-action"
      render={render}
      className={cn("shrink-0", className)}
      {...props}
    />
  );
}

function ToastClose({
  className,
  children,
  render = <Button variant="ghost" size="icon" />,
  ...props
}: WithClassName<ToastPrimitive.Close.Props>) {
  return (
    <ToastPrimitive.Close
      data-slot="toast-close"
      aria-label="Dismiss"
      render={render}
      // Only on hover/focus: at rest the card is just the message. The -inset-2
      // after-element keeps the hit target comfortable at this size.
      className={cn(
        "-mt-px -mr-1 shrink-0 rounded-md text-faint opacity-0 transition-opacity after:absolute after:-inset-2 after:content-[''] hover:bg-ink/8 hover:text-text group-hover/toast:opacity-100 group-focus-within/toast:opacity-100",
        className,
      )}
      {...props}
    >
      {children ?? (
        <X className="size-2.5" aria-hidden="true" />
      )}
    </ToastPrimitive.Close>
  );
}

/**
 * Status glyph for a typed toast, drawn at the chrome's icon scale (12px
 * viewBox, 1.3px strokes) and set in the tinted tile the onboarding screen's
 * choice cards use — scaled from their size-8 to a size-[22px] that suits the
 * notification column. An untyped toast — Suma's default — renders
 * nothing and the message sits flush left.
 */
function ToastIcon({ type }: { type: string | undefined }) {
  const glyph: Partial<Record<ToastType, LucideIcon>> = {
    success: CircleCheck,
    info: Info,
    warning: TriangleAlert,
    error: CircleX,
    loading: LoaderCircle,
  };

  const Icon = glyph[type as ToastType];
  if (Icon === undefined) return null;
  return (
    <span
      data-slot="toast-icon"
      className={cn(
        "grid size-[22px] shrink-0 place-items-center rounded-lg",
        toneFor(type).chip,
      )}
      aria-hidden="true"
    >
      {/* Only the glyph spins — a spinning tile would read as the card
          rotating. */}
      <Icon className={cn("size-3", type === "loading" && "animate-spin")} />
    </span>
  );
}

function ToastList() {
  const { toasts } = ToastPrimitive.useToastManager();

  // Base UI clears an item's content just before retiring its root. Hidden or
  // throttled Electron windows can delay the exit transition, so rendering
  // that shell produces a blank card. Drop contentless retirement frames.
  return toasts
    .filter(
      (item) =>
        item.transitionStatus !== "ending" &&
        (item.title != null || item.description != null),
    )
    .map((item) => (
      <Toast key={item.id} toast={item} className={toneFor(item.type).bloom}>
        <ToastContent>
          <ToastIcon type={item.type} />
          {/* A description that FOLLOWS a title is the supporting line, so it
            dims and drops a step in size; a title-less toast (Suma's
            default shape) keeps the message at full contrast. Base UI renders
            no <h2> without a title, so the sibling selector is the whole
            condition. */}
          <div className="flex min-w-0 flex-1 flex-col gap-0.5 [&>h2+p]:text-[11.5px] [&>h2+p]:text-muted">
            <ToastTitle />
            <ToastDescription />
            {/* Below the message, not beside it. The registry puts the action in
              the content row, which works at its 24rem viewport but not in
              Suma's narrower column (App.tsx): icon, close, and button between
              them take ~130px, and what is left wraps every title of any
              length. `self-start` keeps the button at its
              content width without turning the column into a shrink-to-fit box
              (that would stop the message wrapping at all). Renders nothing
              without actionProps, gap included. */}
            <ToastAction className="mt-1.5 self-start" />
          </div>
          <ToastClose />
        </ToastContent>
      </Toast>
    ));
}

/** Provider + viewport in one. Mount once, inside the notification column. */
function Toaster({
  children,
  toastManager = toast,
  ...props
}: ToastPrimitive.Provider.Props) {
  return (
    <ToastProvider toastManager={toastManager} {...props}>
      {children}
      <ToastViewport>
        <ToastList />
      </ToastViewport>
    </ToastProvider>
  );
}

const useToastManager = ToastPrimitive.useToastManager;

export {
  Toast,
  ToastAction,
  ToastClose,
  ToastContent,
  ToastDescription,
  Toaster,
  ToastProvider,
  ToastTitle,
  ToastViewport,
  toast,
  type ToastType,
  useToastManager,
};
