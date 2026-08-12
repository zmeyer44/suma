import type { ReactNode } from "react";
import type { Transfer, TransferState } from "@suma/protocol";
import type { FilesContext, UploadProgress } from "../bridge";
import { cn } from "../lib/cn";
import { agoLabel, baseName, formatBytes, progressOf } from "../lib/format";
import { CloudIcon, UploadIcon } from "./Icons";
import { ProgressBar, type ProgressTone } from "./ProgressBar";

const TRANSFER_LABEL: Readonly<Record<TransferState, string>> = {
  queued: "Queued",
  fetching: "Fetching",
  storing: "Storing",
  completed: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

const TRANSFER_TONE: Readonly<Record<TransferState, string>> = {
  queued: "text-faint",
  fetching: "text-accent",
  storing: "text-accent",
  completed: "text-ok",
  failed: "text-danger",
  cancelled: "text-faint",
};

function isActive(state: TransferState): boolean {
  return state === "queued" || state === "fetching" || state === "storing";
}

/** Which Mac asked for this fetch — M-3 shows it on every device. */
function originLabel(transfer: Transfer, context: FilesContext | null): string {
  if (transfer.originDeviceId === null) return "unknown device";
  if (context !== null && transfer.originDeviceId === context.thisDeviceId) return "this Mac";
  const match = context?.devices.find((device) => device.id === transfer.originDeviceId);
  return match?.name ?? transfer.originDeviceId;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function SectionHeading({ title, right }: { title: string; right?: ReactNode }) {
  return (
    <div className="flex items-center justify-between px-4 pt-3 pb-1.5">
      <h3 className="text-[11px] font-semibold tracking-wide text-muted uppercase">{title}</h3>
      {right}
    </div>
  );
}

function UploadRow({ upload }: { upload: UploadProgress }) {
  const progress = progressOf(upload.sentBytes, upload.totalBytes);
  const done = upload.state === "completed";
  const failed = upload.state === "failed";
  const tone: ProgressTone = failed ? "danger" : done ? "ok" : "accent";

  return (
    <div className="rounded-xl border border-hairline bg-white/3 px-3 py-2">
      <div className="flex items-center gap-2.5">
        <span className="grid size-6 shrink-0 place-items-center rounded-lg bg-white/6 text-muted">
          <UploadIcon className="size-3" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12.5px] text-text" title={upload.path}>
            {baseName(upload.path)}
          </span>
          <span
            className={cn("block truncate text-[10.5px]", failed ? "text-danger" : "text-faint")}
          >
            {failed
              ? (upload.error ?? "Upload failed.")
              : done
                ? `Uploaded · ${formatBytes(upload.totalBytes)}`
                : upload.state === "hashing"
                  ? `Hashing · ${formatBytes(upload.totalBytes)}`
                  : progress.label}
          </span>
        </span>
        {!done && !failed ? (
          <span className="shrink-0 text-[10.5px] tabular-nums text-faint">
            {progress.percentLabel}
          </span>
        ) : null}
      </div>
      {!done && !failed ? (
        <ProgressBar className="mt-2" fraction={progress.fraction} tone={tone} label="Upload progress" />
      ) : null}
    </div>
  );
}

function TransferRow({
  transfer,
  context,
  onCancel,
}: {
  transfer: Transfer;
  context: FilesContext | null;
  onCancel: (id: string) => void;
}) {
  const progress = progressOf(transfer.receivedBytes, transfer.totalBytes);
  const host = hostOf(transfer.url);
  const active = isActive(transfer.state);

  return (
    <div className="rounded-xl border border-hairline bg-white/3 px-3 py-2">
      <div className="flex items-center gap-2.5">
        <span className="grid size-6 shrink-0 place-items-center rounded-lg bg-white/6 text-muted">
          <CloudIcon className="size-3.5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12.5px] text-text" title={transfer.destPath}>
            {baseName(transfer.destPath)}
          </span>
          <span className="block truncate text-[10.5px] text-faint">
            <span className={TRANSFER_TONE[transfer.state]}>{TRANSFER_LABEL[transfer.state]}</span>
            {transfer.error !== null ? ` · ${transfer.error}` : ` · ${progress.label}`}
            {host.length > 0 ? ` · ${host}` : ""} · from {originLabel(transfer, context)} ·{" "}
            {agoLabel(transfer.updatedAtMs)}
          </span>
        </span>
        {active ? (
          <button
            type="button"
            onClick={() => onCancel(transfer.id)}
            className="shrink-0 cursor-pointer rounded-md bg-danger/15 px-2 py-1 text-[10.5px] font-medium text-danger hover:bg-danger/25"
          >
            Cancel
          </button>
        ) : null}
      </div>
      {active ? (
        <ProgressBar className="mt-2" fraction={progress.fraction} label="Cloud fetch progress" />
      ) : null}
    </div>
  );
}

/**
 * Uploads from this Mac and cloud fetches, kept visually separate: they are
 * different mechanisms with different trust properties, and the footnote says
 * which links the cloud will fetch at all (§8.6 — authenticated downloads stay
 * on this Mac, and Suma never sends credentials to your cloud machine).
 */
export function TransfersPanel({
  uploads,
  transfers,
  context,
  onCancel,
  onClearFinishedUploads,
}: {
  uploads: readonly UploadProgress[];
  transfers: readonly Transfer[];
  context: FilesContext | null;
  onCancel: (id: string) => void;
  onClearFinishedUploads: () => void;
}) {
  const ordered = [...transfers].sort((a, b) => {
    if (isActive(a.state) !== isActive(b.state)) return isActive(a.state) ? -1 : 1;
    return b.updatedAtMs - a.updatedAtMs;
  });
  const finishedUploads = uploads.filter(
    (upload) => upload.state === "completed" || upload.state === "failed",
  );

  return (
    <section className="flex max-h-[42%] shrink-0 flex-col border-t border-hairline bg-panel">
      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        {uploads.length > 0 ? (
          <>
            <SectionHeading
              title="Uploads"
              right={
                finishedUploads.length > 0 ? (
                  <button
                    type="button"
                    onClick={onClearFinishedUploads}
                    className="cursor-pointer text-[10.5px] text-faint hover:text-muted"
                  >
                    Clear finished
                  </button>
                ) : undefined
              }
            />
            <div className="flex flex-col gap-1.5 px-4">
              {uploads.map((upload) => (
                <UploadRow key={upload.uploadId} upload={upload} />
              ))}
            </div>
          </>
        ) : null}

        <SectionHeading title="Cloud fetches" />
        <div className="flex flex-col gap-1.5 px-4">
          {ordered.length === 0 ? (
            <p className="text-[11.5px] leading-relaxed text-faint">
              Nothing fetching. Large downloads from public or presigned links can be handed to your
              cloud machine and land here.
            </p>
          ) : (
            ordered.map((transfer) => (
              <TransferRow
                key={transfer.id}
                transfer={transfer}
                context={context}
                onCancel={onCancel}
              />
            ))
          )}
        </div>
      </div>
      <p className="border-t border-hairline px-4 py-2 text-[10.5px] leading-relaxed text-faint">
        Only downloads that carry no credentials — public or presigned links — can be fetched by
        your cloud machine. Anything that needs a sign-in downloads on this Mac instead.
      </p>
    </section>
  );
}
