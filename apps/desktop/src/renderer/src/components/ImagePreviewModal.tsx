/**
 * The chat image lightbox — a chat thumbnail's expand button opens the full
 * capture here at reading size.
 *
 * A LIGHTBOX, deliberately not a ModalContent folder panel: the folder chrome
 * (title tab, fixed width, body padding) is built for settings-shaped
 * content, and an image wants the opposite — size to the picture, dark veil,
 * click-anywhere-to-dismiss. It still rides the same Base UI dialog
 * primitive, so Escape, backdrop dismissal, and focus containment behave
 * exactly like every other modal — and App counts it into `modalOpen`, which
 * is what makes main raise the chrome above the tab views while it is up
 * (without that the preview would open invisibly UNDER the page).
 */

import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import { useSumaStore } from "../store";

export function ImagePreviewModal() {
  const preview = useSumaStore((s) => s.chatImagePreview);
  const setChatImagePreview = useSumaStore((s) => s.setChatImagePreview);
  const close = (): void => setChatImagePreview(null);

  return (
    <DialogPrimitive.Root
      open={preview !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="modal-veil veil fixed inset-0 z-40" />
        <DialogPrimitive.Popup
          aria-label="Image preview"
          // The popup spans the window so ANY click outside the picture
          // dismisses — the figure stops propagation to stay clickable.
          onClick={close}
          className="modal-pop fixed inset-0 z-40 grid place-items-center p-10 outline-none"
        >
          {preview === null ? null : (
            <figure
              onClick={(e) => e.stopPropagation()}
              className="relative flex max-h-full max-w-full flex-col items-center gap-2"
            >
              <DialogPrimitive.Title className="sr-only">
                {preview.alt || "Image preview"}
              </DialogPrimitive.Title>
              <img
                src={preview.src}
                alt={preview.alt}
                className="filter-(--drop-modal) min-h-0 max-h-[82vh] max-w-full rounded-xl border border-hairline bg-bg object-contain"
              />
              {preview.alt !== "" ? (
                <figcaption className="max-w-[70vw] truncate rounded-full bg-ink/70 px-3 py-1 text-[11.5px] text-bg">
                  {preview.alt}
                </figcaption>
              ) : null}
              <DialogPrimitive.Close
                title="Close preview (Esc)"
                aria-label="Close preview"
                className="absolute -top-2.5 -right-2.5 grid size-7 cursor-pointer place-items-center rounded-full border border-hairline bg-bg text-muted shadow-md transition-colors hover:text-text"
              >
                <X className="size-3.5" aria-hidden="true" />
              </DialogPrimitive.Close>
            </figure>
          )}
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
