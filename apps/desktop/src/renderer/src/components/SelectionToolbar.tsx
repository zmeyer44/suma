/**
 * The floating selection toolbar — the page rendered inside its own
 * transparent WebContentsView (shell-window.ts), shown over a tab page when
 * a text selection settles there. Deliberately dumb: it never sees the
 * selected text, only offers the two actions; a tap goes to main
 * (`selectionToolbar:action`), which relays the selection it cached to the
 * chrome and hides this view.
 *
 * The box is the FIXED size shared/selection.ts declares — main sizes the
 * view to exactly those dimensions (the view swallows clicks over its whole
 * rect), so the panel must fill them edge to edge, no margins.
 */

import { MessageSquarePlus, Volume2 } from "lucide-react";
import {
  SELECTION_TOOLBAR_HEIGHT,
  SELECTION_TOOLBAR_WIDTH,
  type SelectionToolbarAction,
} from "../../../shared/selection";

const ACTION_CLASS =
  "flex flex-1 cursor-pointer items-center justify-center gap-1.5 text-[11.5px] font-medium text-muted transition-colors hover:bg-ink/8 hover:text-text";

export function SelectionToolbar() {
  const act = (action: SelectionToolbarAction): void => {
    if (!window.suma) return;
    void window.suma
      .invoke("selectionToolbar:action", { action })
      .catch(() => undefined);
  };

  return (
    <div
      style={{ width: SELECTION_TOOLBAR_WIDTH, height: SELECTION_TOOLBAR_HEIGHT }}
      className="overlay-glass flex items-stretch overflow-hidden rounded-lg border border-ink/15"
    >
      <button
        type="button"
        title="Read the selection aloud"
        aria-label="Read aloud"
        onClick={() => act("readAloud")}
        className={ACTION_CLASS}
      >
        <Volume2 className="size-3" aria-hidden="true" />
        Read aloud
      </button>
      <div className="w-px shrink-0 bg-hairline" aria-hidden="true" />
      <button
        type="button"
        title="Attach the selection to your next chat message"
        aria-label="Add to chat"
        onClick={() => act("addToChat")}
        className={ACTION_CLASS}
      >
        <MessageSquarePlus className="size-3" aria-hidden="true" />
        Add to chat
      </button>
    </div>
  );
}
