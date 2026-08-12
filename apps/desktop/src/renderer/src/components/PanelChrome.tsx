/**
 * The right-edge panel shell — the mount/expand choreography ChatSidebar
 * pioneered and SavesPanel copied, extracted for panels that don't need a
 * resize handle. A panel is a flex SIBLING of the content hole: it takes
 * real layout width, the hole narrows, and main resizes the tab views onto
 * the smaller region (ContentPanes reports it).
 *
 * Two frames before expanding for the same reason as everywhere else: the
 * zero-width state must paint first or there is nothing to transition from.
 * OPEN_MS/CLOSE_MS must match `.chat-slide` in styles.css.
 */

import { useEffect, useRef, useState } from "react";
import { cn } from "../lib/cn";

const OPEN_MS = 220;
const CLOSE_MS = 160;

export function PanelChrome({
  open,
  width,
  label,
  children,
}: {
  open: boolean;
  width: number;
  label: string;
  children: React.ReactNode;
}) {
  // Only the <aside> unmounts; the component stays, so inner state (a
  // half-checked remember box, scroll position) survives a close.
  const [mounted, setMounted] = useState(open);
  const [expanded, setExpanded] = useState(open);
  const [animating, setAnimating] = useState(false);
  const firstRun = useRef(true);

  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    if (open) {
      setMounted(true);
      setAnimating(true);
      let inner = 0;
      const outer = requestAnimationFrame(() => {
        inner = requestAnimationFrame(() => setExpanded(true));
      });
      const settle = window.setTimeout(() => setAnimating(false), OPEN_MS + 60);
      return () => {
        cancelAnimationFrame(outer);
        cancelAnimationFrame(inner);
        window.clearTimeout(settle);
      };
    }
    setAnimating(true);
    setExpanded(false);
    const settle = window.setTimeout(() => {
      setMounted(false);
      setAnimating(false);
    }, CLOSE_MS);
    return () => window.clearTimeout(settle);
  }, [open]);

  if (!mounted) return null;

  return (
    <aside
      aria-label={label}
      inert={open ? undefined : true}
      data-closing={open ? undefined : ""}
      style={{ width: expanded ? width : 0 }}
      className={cn("no-drag relative h-full shrink-0", animating && "chat-slide")}
    >
      <div className="h-full w-full overflow-hidden">
        {/* Width-pinned inside overflow-hidden so content doesn't reflow
            during the slide. */}
        <div
          style={{ width }}
          className="flex h-full flex-col border-l border-chrome-edge bg-chrome"
        >
          {children}
        </div>
      </div>
    </aside>
  );
}
