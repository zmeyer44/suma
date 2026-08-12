import { cn } from "../lib/cn";
import type { StatusMessage } from "../state";
import { CloseIcon } from "./Icons";

const TONE: Readonly<Record<StatusMessage["tone"], string>> = {
  info: "border-hairline bg-white/4 text-muted",
  ok: "border-ok/25 bg-ok/10 text-ok",
  warn: "border-warn/25 bg-warn/10 text-warn",
  danger: "border-danger/25 bg-danger/10 text-danger",
};

export function StatusBanner({
  status,
  onDismiss,
}: {
  status: StatusMessage | null;
  onDismiss: () => void;
}) {
  if (status === null) return null;
  return (
    <div
      role="status"
      className={cn(
        "animate-overlay-in mx-4 mt-3 flex items-start gap-3 rounded-xl border px-3 py-2 text-[12px]",
        TONE[status.tone],
      )}
    >
      <span className="min-w-0 flex-1 leading-snug">{status.text}</span>
      <button
        type="button"
        aria-label="Dismiss message"
        onClick={onDismiss}
        className="mt-0.5 grid size-4 cursor-pointer place-items-center rounded text-current opacity-60 hover:opacity-100"
      >
        <CloseIcon className="size-2" />
      </button>
    </div>
  );
}
