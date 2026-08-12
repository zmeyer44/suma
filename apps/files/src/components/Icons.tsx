/** Inline icons — no icon font, no remote assets (strict CSP page). */

import { cn } from "../lib/cn";

interface IconProps {
  className?: string;
}

function stroke(className: string | undefined, viewBox: string, d: string) {
  return (
    <svg viewBox={viewBox} className={className ?? "size-3.5"} aria-hidden="true">
      <path
        d={d}
        stroke="currentColor"
        strokeWidth="1.4"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function ChevronIcon({ className, open }: IconProps & { open: boolean }) {
  return (
    <svg
      viewBox="0 0 10 10"
      className={cn(className ?? "size-2.5", "transition-transform duration-150", open && "rotate-90")}
      aria-hidden="true"
    >
      <path d="M3.5 2l3.5 3-3.5 3" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function FolderIcon({ className }: IconProps) {
  return stroke(className, "0 0 14 14", "M1.5 3.5h3.6l1.2 1.5h6.2v5.5a1 1 0 01-1 1H2.5a1 1 0 01-1-1z");
}

export function FileIcon({ className }: IconProps) {
  return stroke(className, "0 0 14 14", "M3.5 1.5h5l3 3v8a1 1 0 01-1 1h-7a1 1 0 01-1-1v-10a1 1 0 011-1zM8.5 1.5v3h3");
}

export function UploadIcon({ className }: IconProps) {
  return stroke(className, "0 0 14 14", "M7 10.5v-8M4 5.5L7 2.5l3 3M2.5 12h9");
}

export function DownloadIcon({ className }: IconProps) {
  return stroke(className, "0 0 14 14", "M7 1.5v7M4 5.5L7 8.5l3-3M2.5 11h9");
}

export function TrashIcon({ className }: IconProps) {
  return stroke(className, "0 0 14 14", "M2.5 3.5h9M5.5 3.5V2h3v1.5M3.5 3.5l.6 8a1 1 0 001 1h3.8a1 1 0 001-1l.6-8M6 6v4M8 6v4");
}

export function CloudIcon({ className }: IconProps) {
  return stroke(className, "0 0 16 14", "M4.6 11.5a3.1 3.1 0 01-.3-6.2 4 4 0 017.6-1 2.9 2.9 0 01.5 5.7M8 6.5v5.5M6 10.2l2 2 2-2");
}

export function CloseIcon({ className }: IconProps) {
  return stroke(className ?? "size-2.5", "0 0 10 10", "M1 1l8 8M9 1l-8 8");
}
