import { useEffect } from "react";
import { CloudDownload, Download } from "lucide-react";
import type { Transfer } from "@suma/protocol";
import type { CloudFetchDeclined, DownloadItemInfo } from "../../../shared/ipc";
import { cn } from "../lib/cn";
import { agoLabel, downloadProgress, formatBytes } from "../lib/format";
import { hostOf } from "../lib/url";
import { useSumaStore } from "../store";
import { Button } from "./ui/button";
import { Modal, ModalBody, ModalContent } from "./ui/modal";

function stateLabel(item: DownloadItemInfo, movedToCloud: boolean): { text: string; className: string } {
  switch (item.state) {
    case "progressing":
      return { text: downloadProgress(item.receivedBytes, item.totalBytes).label, className: "text-muted" };
    case "completed":
      // cloudPath = the finished file was also mirrored onto the account's
      // computer (cloud mode) — the one detail worth a word here.
      return item.cloudPath !== undefined
        ? {
            text: `${formatBytes(item.receivedBytes)} · also on your computer`,
            className: "text-faint",
          }
        : { text: formatBytes(item.receivedBytes), className: "text-faint" };
    case "cancelled":
      // The local download was stopped because the cloud is fetching it — say
      // that, rather than leaving a bare "Cancelled" the user did not do.
      return movedToCloud
        ? { text: "Moved to a cloud fetch", className: "text-accent" }
        : { text: "Cancelled", className: "text-faint" };
    case "interrupted":
      return { text: "Interrupted", className: "text-danger" };
  }
}

const TRANSFER_LABELS: Readonly<Record<Transfer["state"], string>> = {
  queued: "Queued in the cloud",
  fetching: "Fetching in the cloud",
  storing: "Storing in ~/cloud",
  completed: "In ~/cloud",
  failed: "Failed",
  cancelled: "Cancelled",
};

function TransferRow({ transfer }: { transfer: Transfer & { cancellable?: boolean } }) {
  const cancelTransfer = useSumaStore((s) => s.cancelTransfer);
  const active =
    transfer.state === "queued" || transfer.state === "fetching" || transfer.state === "storing";
  // Cancellable is true for active fetches; false only in the brief window
  // where a cancel is already in flight (the button would be a no-op).
  const cancellable = transfer.cancellable !== false;
  const progress = downloadProgress(transfer.receivedBytes, transfer.totalBytes);
  const host = hostOf(transfer.url);

  return (
    <div className="rounded-xl border border-hairline bg-ink/3 px-3 py-2.5">
      <div className="flex items-center gap-3">
        <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-accent/15 text-accent">
          <CloudDownload className="size-3.5" aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] text-text" title={transfer.destPath}>
            {transfer.destPath.split("/").pop() ?? transfer.destPath}
          </span>
          <span className="block truncate text-[10.5px] text-muted">
            {TRANSFER_LABELS[transfer.state]}
            {active ? ` · ${progress.label}` : ""}
            {host.length > 0 ? ` · ${host}` : ""} · {agoLabel(transfer.startedAtMs)}
          </span>
          {transfer.error !== null ? (
            <span className="block truncate text-[10.5px] text-danger" title={transfer.error}>
              {transfer.error}
            </span>
          ) : null}
        </span>
        {active && !cancellable ? (
          <span className="shrink-0 text-[10.5px] text-faint">Cancelling…</span>
        ) : active || transfer.state === "failed" ? (
          <Button
            size="sm"
            variant={transfer.state === "failed" ? "secondary" : "danger"}
            onClick={() => void cancelTransfer(transfer.id)}
          >
            {transfer.state === "failed" ? "Dismiss" : "Cancel"}
          </Button>
        ) : null}
      </div>
      {active ? (
        <div className="mt-2 h-[4px] w-full overflow-hidden rounded-full bg-ink/8">
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-200"
            style={{ width: `${String(Math.round((progress.fraction ?? 0) * 100))}%` }}
          />
        </div>
      ) : null}
    </div>
  );
}

/** §8.6 verbatim: why this download stayed on this Mac. */
function DeclinedNotice({ declined }: { declined: CloudFetchDeclined }) {
  return (
    <div className="rounded-xl border border-hairline bg-ink/3 px-3 py-2.5">
      <p className="text-[12px] text-text">{declined.filename} stayed on this Mac</p>
      <p className="mt-1 text-[11px] text-muted">{declined.explanation}</p>
    </div>
  );
}

function DownloadRow({ item, movedToCloud }: { item: DownloadItemInfo; movedToCloud: boolean }) {
  const openDownload = useSumaStore((s) => s.openDownload);
  const revealDownload = useSumaStore((s) => s.revealDownload);
  const cancelDownload = useSumaStore((s) => s.cancelDownload);

  const progress = downloadProgress(item.receivedBytes, item.totalBytes);
  const sub = stateLabel(item, movedToCloud);
  const host = hostOf(item.url);

  return (
    <div className="rounded-xl border border-hairline bg-ink/3 px-3 py-2.5">
      <div className="flex items-center gap-3">
        <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-ink/6 text-muted">
          <Download className="size-3.5" aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] text-text" title={item.savePath}>
            {item.filename}
          </span>
          <span className={cn("block truncate text-[10.5px]", sub.className)}>
            {sub.text}
            {host.length > 0 ? ` · ${host}` : ""} · {agoLabel(item.startedAtMs)}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          {item.state === "progressing" ? (
            <Button size="sm" variant="danger" onClick={() => void cancelDownload(item.id)}>
              Cancel
            </Button>
          ) : null}
          {item.state === "completed" ? (
            <>
              <Button size="sm" variant="soft" onClick={() => void openDownload(item.id)}>
                Open
              </Button>
              <Button size="sm" variant="secondary" onClick={() => void revealDownload(item.id)}>
                Reveal
              </Button>
            </>
          ) : null}
        </span>
      </div>
      {item.state === "progressing" ? (
        <div className="mt-2 h-[4px] w-full overflow-hidden rounded-full bg-ink/8">
          {progress.fraction !== null ? (
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-200"
              style={{ width: `${Math.round(progress.fraction * 100)}%` }}
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
      ) : null}
    </div>
  );
}

/**
 * Downloads overlay (§8.1): live list with progress, open/reveal/cancel, plus
 * the §8.6 cloud-fetch view — what the cloud is fetching, and what stayed here.
 */
export function DownloadsPanel() {
  const open = useSumaStore((s) => s.overlay === "downloads");
  const setOverlay = useSumaStore((s) => s.setOverlay);
  const downloads = useSumaStore((s) => s.downloads);
  const transfers = useSumaStore((s) => s.transfers);
  const declinedFetch = useSumaStore((s) => s.declinedFetch);
  const refreshDownloads = useSumaStore((s) => s.refreshDownloads);
  const refreshTransfers = useSumaStore((s) => s.refreshTransfers);

  useEffect(() => {
    if (!open) return;
    void refreshDownloads();
    void refreshTransfers();
  }, [open, refreshDownloads, refreshTransfers]);

  const ordered = [...downloads].sort((a, b) => b.startedAtMs - a.startedAtMs);
  // A local download cancelled because the same URL became a cloud fetch.
  const cloudUrls = new Set(transfers.map((transfer) => transfer.url));

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!next) setOverlay("none");
      }}
    >
      <ModalContent
        title="Downloads"
        width={520}
        height="max-h-[72vh]"
        icon={
          <Download className="size-3.5" aria-hidden="true" />
        }
      >
        <ModalBody className="px-4 py-3">
          {transfers.length > 0 || declinedFetch !== null ? (
            <section className="mb-3 flex flex-col gap-1.5">
              <h3 className="px-0.5 text-[10.5px] font-medium tracking-wide text-faint uppercase">
                Cloud fetches
              </h3>
              {transfers.map((transfer) => (
                <TransferRow key={transfer.id} transfer={transfer} />
              ))}
              {declinedFetch !== null ? <DeclinedNotice declined={declinedFetch} /> : null}
            </section>
          ) : null}

          {ordered.length === 0 ? (
            transfers.length === 0 ? (
              <p className="py-10 text-center text-[12px] text-faint">
                No downloads yet — files you download land here.
              </p>
            ) : null
          ) : (
            <div className="flex flex-col gap-1.5">
              {ordered.map((item) => (
                <DownloadRow key={item.id} item={item} movedToCloud={cloudUrls.has(item.url)} />
              ))}
            </div>
          )}
        </ModalBody>
      </ModalContent>
    </Modal>
  );
}
