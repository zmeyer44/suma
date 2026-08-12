import { useEffect, useState, type ReactNode } from "react";
import type { FileEntry } from "@suma/protocol";
import { cn } from "../lib/cn";
import { agoLabel, baseName, formatBytes } from "../lib/format";
import { skipExplanation, type PreviewPlan } from "../lib/preview";
import { breadcrumbs } from "../lib/tree";
import type { PreviewState } from "../state";
import { DownloadIcon, FileIcon, TrashIcon } from "./Icons";

function ActionButton({
  label,
  tone,
  icon,
  busy,
  disabled,
  onClick,
}: {
  label: string;
  tone: "accent" | "plain" | "danger";
  icon: ReactNode;
  busy?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  const toneClass =
    tone === "accent"
      ? "bg-accent/15 text-accent hover:bg-accent/25"
      : tone === "danger"
        ? "bg-danger/15 text-danger hover:bg-danger/25"
        : "bg-white/6 text-muted hover:bg-white/10 hover:text-text";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled === true || busy === true}
      className={cn(
        "flex cursor-pointer items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11.5px] font-medium disabled:cursor-default disabled:opacity-50",
        toneClass,
      )}
    >
      {icon}
      {busy === true ? "Working…" : label}
    </button>
  );
}

function PreviewBody({ preview, plan }: { preview: PreviewState; plan: PreviewPlan }) {
  switch (preview.status) {
    case "loading":
      return <p className="p-6 text-[12px] text-faint">Loading preview…</p>;
    case "text":
      return (
        <div className="min-h-0 flex-1 overflow-auto">
          <pre className="px-5 py-4 font-mono text-[11.5px] leading-[1.55] whitespace-pre-wrap text-text">
            {preview.text}
          </pre>
          {preview.truncated ? (
            <p className="px-5 pb-4 text-[11px] text-faint">
              Showing the first {formatBytes(plan.readBytes)} — download the file for the rest.
            </p>
          ) : null}
        </div>
      );
    case "image":
      return (
        <div className="grid min-h-0 flex-1 place-items-center overflow-auto p-6">
          <img
            src={preview.url}
            alt={baseName(preview.path)}
            className="max-h-full max-w-full rounded-lg bg-white/4 object-contain shadow-pop"
          />
        </div>
      );
    case "info":
      return (
        <div className="grid min-h-0 flex-1 place-items-center p-8 text-center">
          <div>
            <span className="mx-auto mb-3 grid size-10 place-items-center rounded-xl bg-white/6 text-faint">
              <FileIcon className="size-5" />
            </span>
            <p className="text-[13px] text-text">{plan.typeLabel}</p>
            <p className="mt-1 text-[12px] text-faint">{skipExplanation(plan)}</p>
          </div>
        </div>
      );
    case "error":
      return <p className="p-6 text-[12px] text-danger">{preview.message}</p>;
    case "idle":
      return null;
  }
}

/** Right-hand pane: text and images inline, everything else as type + size. */
export function PreviewPane({
  entry,
  plan,
  preview,
  downloading,
  deleting,
  onDownload,
  onDelete,
}: {
  entry: FileEntry | null;
  plan: PreviewPlan | null;
  preview: PreviewState;
  downloading: boolean;
  deleting: boolean;
  onDownload: (path: string) => void;
  onDelete: (path: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const path = entry?.path ?? null;

  useEffect(() => {
    setConfirming(false);
  }, [path]);

  if (entry === null || plan === null) {
    return (
      <section className="grid min-h-0 flex-1 place-items-center text-center">
        <p className="max-w-[320px] text-[12.5px] leading-relaxed text-faint">
          Select a file to preview it. Text and images open here; anything else shows its type and
          size.
        </p>
      </section>
    );
  }

  const crumbs = breadcrumbs(entry.path);
  // The preview effect runs after this render, so for one frame the loaded
  // preview can still belong to the previously selected file. Never paint one
  // file's contents under another file's name.
  const stale = preview.status !== "idle" && preview.path !== entry.path;
  const body: PreviewState = stale ? { status: "loading", path: entry.path } : preview;

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-start gap-3 border-b border-hairline px-5 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[14px] font-semibold text-text">{baseName(entry.path)}</h2>
          <p className="mt-0.5 truncate text-[11px] text-faint">
            {crumbs.slice(0, -1).map((crumb) => `${crumb.name}/`)}
            {crumbs.length > 1 ? " · " : ""}
            {plan.typeLabel} · {formatBytes(entry.sizeBytes)} · updated {agoLabel(entry.updatedAtMs)}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <ActionButton
            label="Download"
            tone="accent"
            busy={downloading}
            icon={<DownloadIcon className="size-3" />}
            onClick={() => onDownload(entry.path)}
          />
          {confirming ? (
            <>
              <ActionButton
                label="Confirm delete"
                tone="danger"
                busy={deleting}
                icon={<TrashIcon className="size-3" />}
                onClick={() => onDelete(entry.path)}
              />
              <ActionButton
                label="Keep"
                tone="plain"
                icon={null}
                onClick={() => setConfirming(false)}
              />
            </>
          ) : (
            <ActionButton
              label="Delete"
              tone="danger"
              icon={<TrashIcon className="size-3" />}
              onClick={() => setConfirming(true)}
            />
          )}
        </div>
      </header>
      <PreviewBody preview={body} plan={plan} />
    </section>
  );
}
