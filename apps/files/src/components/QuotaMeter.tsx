import { cn } from "../lib/cn";
import type { QuotaSummary } from "../lib/quota";
import { ProgressBar, type ProgressTone } from "./ProgressBar";

const TONE_TEXT: Readonly<Record<QuotaSummary["tone"], string>> = {
  ok: "text-muted",
  warn: "text-warn",
  danger: "text-danger",
};

const TONE_BAR: Readonly<Record<QuotaSummary["tone"], ProgressTone>> = {
  ok: "accent",
  warn: "warn",
  danger: "danger",
};

/**
 * Used / limit with the soft-block state (§8.6). When it is full it says so
 * *and* says nothing was deleted, because that is the part users don't assume.
 */
export function QuotaMeter({ summary }: { summary: QuotaSummary }) {
  return (
    <div className="w-[230px] shrink-0">
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-[11px] text-muted">{summary.usageLabel}</span>
        <span className={cn("text-[11px] font-medium tabular-nums", TONE_TEXT[summary.tone])}>
          {summary.percentLabel}
        </span>
      </div>
      <ProgressBar
        fraction={summary.fraction}
        tone={TONE_BAR[summary.tone]}
        label="Files quota used"
      />
      {summary.note.length > 0 ? (
        <p className={cn("mt-1 text-[10.5px] leading-snug", TONE_TEXT[summary.tone])}>{summary.note}</p>
      ) : null}
    </div>
  );
}
