import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import { useId, useRef } from "react";
import { cn } from "../../lib/cn";
import { folderOutline, type FolderGeometry } from "../../lib/folder";
import { useMeasuredWidth } from "../../lib/measure";

/**
 * shadcn-style dialog (https://ui.shadcn.com/docs/components/base/dialog) on
 * the Base UI primitive, drawn as Suma chrome: the panel is a manila folder
 * pulled up out of the drawer. Its title sits in a folder-shaped tab on the
 * top edge — the same silhouette as the tab strip's active tab (lib/folder),
 * at a slightly smaller scale — whose fill merges seamlessly into the panel
 * and whose 1px silhouette highlight continues into the panel's border. One
 * compound drop-shadow falls from the whole folder outline, tab included.
 *
 * Usage:
 *   <Modal open={open} onOpenChange={...}>
 *     <ModalContent title="Downloads" icon={<Download …/>} badge={…} actions={…}>
 *       <ModalBody>…</ModalBody>
 *       <ModalFooter>…</ModalFooter>
 *     </ModalContent>
 *   </Modal>
 */

/** The title tab's silhouette — the active tab's geometry at ~90% scale. */
const TAB: FolderGeometry = { h: 36, flare: 8, radius: 10, taper: 3 };

/**
 * The folder-shaped backdrop behind the title tab; flares overflow 8px per
 * side. The gradient's bottom stop is exactly the panel's top color and the
 * fill overdraws the panel's border row (the header renders above the panel,
 * which is pulled up 1px), so tab and panel read as one surface.
 */
function FolderTabShell() {
  const [ref, width] = useMeasuredWidth();
  const gradientId = useId();

  return (
    <div
      ref={ref}
      aria-hidden="true"
      className="pointer-events-none absolute inset-y-0 -inset-x-2"
    >
      {width > 0 ? (
        <svg
          width={width}
          height={TAB.h}
          className="absolute inset-0 overflow-visible"
        >
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              {/* style, not stopColor: var() only resolves through CSS. */}
              <stop offset="0" style={{ stopColor: "var(--color-modal-wash)" }} />
              <stop offset="0.65" style={{ stopColor: "var(--color-modal)" }} />
            </linearGradient>
          </defs>
          <path
            d={`${folderOutline(width, TAB)} Z`}
            fill={`url(#${gradientId})`}
          />
          <path
            d={folderOutline(width, TAB)}
            fill="none"
            stroke="var(--color-modal-edge)"
            strokeWidth="1.5"
          />
        </svg>
      ) : null}
    </div>
  );
}

function Modal(props: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root {...props} />;
}

function ModalTrigger(
  props: React.ComponentProps<typeof DialogPrimitive.Trigger>,
) {
  return <DialogPrimitive.Trigger data-slot="modal-trigger" {...props} />;
}

function ModalClose(props: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="modal-close" {...props} />;
}

function ModalContent({
  title,
  icon,
  badge,
  actions,
  description,
  width = 520,
  height = "max-h-[76vh]",
  dismissible = true,
  className,
  children,
}: {
  title: React.ReactNode;
  /** Bare 12px glyph; rendered in an accent-tinted tile inside the tab. */
  icon?: React.ReactNode;
  /** Tiny status pill after the title (the tab strip's Split-badge idiom). */
  badge?: React.ReactNode;
  /** Extra header buttons, left of the close button. */
  actions?: React.ReactNode;
  /** Muted caption strip across the top of the panel. */
  description?: React.ReactNode;
  width?: number;
  /** Panel height classes; replaces the default `max-h-[76vh]`. */
  height?: string;
  /** When false, hides the close button (ceremonies the user must finish). */
  dismissible?: boolean;
  /** Extra classes for the panel. */
  className?: string;
  children: React.ReactNode;
}) {
  // Land initial focus on the popup itself: Base UI's default (the first
  // tabbable element) opens every modal with a focus ring on the close button.
  const popupRef = useRef<HTMLDivElement>(null);
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Backdrop className="modal-veil veil fixed inset-0 z-40" />
      <DialogPrimitive.Popup
        ref={popupRef}
        initialFocus={popupRef}
        data-slot="modal-content"
        className="modal-pop fixed inset-x-0 top-[8vh] z-40 mx-auto outline-none"
        style={{ width, maxWidth: "calc(100vw - 48px)" }}
      >
        <div className="filter-(--drop-modal) rounded-2xl bg-modal-deep pt-2.5">
          {/* Header strip: the title tab, then floating actions. z-10 so the
              tab's fill covers the panel border running beneath it. */}
          <header className="relative z-10 flex h-9 items-end pl-6.5 pr-3">
            <div className="relative flex h-full min-w-0 items-center px-3.5">
              <FolderTabShell />
              <span className="relative flex min-w-0 items-center gap-2">
                {icon !== undefined ? (
                  <span className="grid size-4.5 shrink-0 place-items-center rounded-[5px] bg-accent/15 text-accent">
                    {icon}
                  </span>
                ) : null}
                <DialogPrimitive.Title className="min-w-0 truncate text-[13px] font-semibold text-text">
                  {title}
                </DialogPrimitive.Title>
                {badge}
              </span>
            </div>
            <span className="min-w-4 flex-1" />
            <span className="mb-2.5 flex shrink-0 items-center gap-1.5">
              {actions}
              {dismissible ? (
                <DialogPrimitive.Close
                  aria-label="Close"
                  className="grid size-6.5 cursor-pointer place-items-center rounded-lg bg-linear-to-b from-ink/4 to-ink/8 text-muted outline-none hover:from-ink/8 hover:to-ink/14 hover:text-text focus-visible:ring-2 focus-visible:ring-accent/40"
                >
                  <X className="size-3" aria-hidden="true" />
                </DialogPrimitive.Close>
              ) : null}
            </span>
          </header>
          <div
            className={cn(
              "relative -mt-px flex",
              height,
              "flex-col overflow-hidden rounded-2xl border border-modal-edge bg-[linear-gradient(180deg,var(--color-modal)_0%,var(--color-modal-deep)_100%)]",
              className,
            )}
          >
            {description !== undefined ? (
              <DialogPrimitive.Description className="shrink-0 border-b border-hairline bg-recess px-5 py-2.5 text-[11px] leading-snug text-faint">
                {description}
              </DialogPrimitive.Description>
            ) : null}
            {children}
          </div>
        </div>
      </DialogPrimitive.Popup>
    </DialogPrimitive.Portal>
  );
}

/** Scrollable content region between header and footer. */
function ModalBody({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="modal-body"
      className={cn("min-h-0 flex-1 overflow-y-auto", className)}
      {...props}
    />
  );
}

/**
 * Recessed action bar along the panel's bottom edge; right-aligns Buttons.
 * Lead with an `mr-auto` element for footer notes.
 */
function ModalFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="modal-footer"
      className={cn(
        "flex shrink-0 items-center justify-end gap-2 border-t border-hairline bg-recess px-4 py-3",
        className,
      )}
      {...props}
    />
  );
}

export {
  Modal,
  ModalBody,
  ModalClose,
  ModalContent,
  ModalFooter,
  ModalTrigger,
};
