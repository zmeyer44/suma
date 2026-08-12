import { cn } from "../lib/cn";

export type ProgressTone = "accent" | "ok" | "warn" | "danger";

const TRACK: Readonly<Record<ProgressTone, string>> = {
  accent: "bg-accent",
  ok: "bg-ok",
  warn: "bg-warn",
  danger: "bg-danger",
};

/**
 * One bar for uploads, cloud fetches and the quota meter. `fraction: null`
 * means "we genuinely don't know how far along this is" and animates instead
 * of inventing a number.
 */
export function ProgressBar({
  fraction,
  tone = "accent",
  className = "",
  label,
}: {
  fraction: number | null;
  tone?: ProgressTone;
  className?: string;
  label?: string;
}) {
  const percent = fraction === null ? null : Math.round(Math.min(1, Math.max(0, fraction)) * 100);
  return (
    <div
      className={cn("h-[5px] w-full overflow-hidden rounded-full bg-white/8", className)}
      role="progressbar"
      aria-label={label}
      aria-valuenow={percent ?? undefined}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      {percent !== null ? (
        <div
          className={cn("h-full rounded-full", TRACK[tone], "transition-[width] duration-300")}
          style={{ width: `${percent}%` }}
        />
      ) : (
        <div
          className="animate-shimmer h-full w-full rounded-full"
          style={{
            background:
              "linear-gradient(90deg, transparent, var(--color-accent) 45%, var(--color-accent) 55%, transparent)",
            backgroundSize: "200% 100%",
          }}
        />
      )}
    </div>
  );
}
