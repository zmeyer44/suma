import { useMemo, useRef } from "react";
import { resolveBridge } from "./bridge-source";
import { FileTree } from "./components/FileTree";
import { UploadIcon } from "./components/Icons";
import { PreviewPane } from "./components/PreviewPane";
import { formatBytes, formatCount } from "./lib/format";
import { QuotaMeter } from "./components/QuotaMeter";
import { StatusBanner } from "./components/StatusBanner";
import { TransfersPanel } from "./components/TransfersPanel";
import { useFilesApp } from "./state";

/**
 * Standing statement about what this app is showing. Every clause is load
 * bearing (§8.6): `~/cloud` is the only cloud-native location, the rest of
 * `$HOME` is a snapshotted volume rather than a second canonical copy, and in
 * V1 none of it is end-to-end encrypted. Overstating any of the three would be
 * a security claim Suma cannot keep.
 */
function FooterNote({ cloudRoot, endToEndEncrypted }: { cloudRoot: string; endToEndEncrypted: boolean }) {
  return (
    <footer className="flex items-center gap-2 border-t border-hairline bg-panel px-4 py-2 text-[10.5px] leading-relaxed text-faint">
      <span>
        Files holds what lives in <span className="font-mono text-muted">{cloudRoot}</span> — the one
        cloud-native location, canonical in R2. The rest of your home directory stays on your cloud
        machine&apos;s volume with periodic snapshots, and is not browsable here.
      </span>
      {!endToEndEncrypted ? (
        <span className="shrink-0 rounded-md bg-warn/10 px-2 py-1 text-warn">
          Not end-to-end encrypted in V1
        </span>
      ) : null}
    </footer>
  );
}

export function App() {
  // Resolved once: swapping bridges mid-session would silently change what
  // "your files" means.
  const { bridge, isMock } = useMemo(() => resolveBridge(), []);
  const app = useFilesApp(bridge, isMock);
  const fileInput = useRef<HTMLInputElement>(null);

  const softBlocked = app.quotaSummary.softBlocked;

  return (
    <div className="flex h-full flex-col bg-bg text-text">
      <header className="flex items-center gap-4 border-b border-hairline bg-panel px-4 py-2.5">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <h1 className="text-[14px] font-semibold">Files</h1>
          {app.isMock ? (
            <span
              className="rounded-md bg-warn/15 px-1.5 py-0.5 text-[10px] font-medium text-warn"
              title="No Suma bridge on this page — everything shown is sample data."
            >
              Mock data
            </span>
          ) : null}
          <span className="truncate text-[11px] text-faint">
            {app.tree.fileCount === 0
              ? "No files yet"
              : `${formatCount(app.tree.fileCount, "file")} · ${formatBytes(app.tree.sizeBytes)}`}
          </span>
        </div>

        <QuotaMeter summary={app.quotaSummary} />

        <button
          type="button"
          onClick={() => fileInput.current?.click()}
          disabled={softBlocked}
          title={
            softBlocked
              ? "Files is full — free up space to upload. Nothing already stored has been removed."
              : `Upload into ${app.uploadDir}`
          }
          className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg bg-accent/15 px-3 py-1.5 text-[12px] font-medium text-accent hover:bg-accent/25 disabled:cursor-default disabled:opacity-50"
        >
          <UploadIcon className="size-3.5" />
          Upload
        </button>
        <input
          ref={fileInput}
          type="file"
          multiple
          className="hidden"
          onChange={(event) => {
            const files = [...(event.target.files ?? [])];
            event.target.value = "";
            void app.uploadFiles(files);
          }}
        />
      </header>

      <StatusBanner status={app.status} onDismiss={app.clearStatus} />

      <div className="flex min-h-0 flex-1">
        <FileTree
          rows={app.rows}
          ready={app.ready}
          selectedPath={app.selectedPath}
          uploadDir={app.uploadDir}
          softBlocked={softBlocked}
          onSelect={app.select}
          onToggle={app.toggleDir}
          onDropFiles={(files) => void app.uploadFiles(files)}
        />
        <main className="flex min-w-0 flex-1 flex-col">
          <PreviewPane
            entry={app.selectedEntry}
            plan={app.previewPlan}
            preview={app.preview}
            downloading={app.downloadingPath === app.selectedEntry?.path}
            deleting={app.deletingPath === app.selectedEntry?.path}
            onDownload={(path) => void app.download(path)}
            onDelete={(path) => void app.remove(path)}
          />
          <TransfersPanel
            uploads={app.uploads}
            transfers={app.transfers}
            context={app.context}
            onCancel={(id) => void app.cancelTransfer(id)}
            onClearFinishedUploads={app.clearFinishedUploads}
          />
        </main>
      </div>

      <FooterNote
        cloudRoot={app.context?.cloudRoot ?? "~/cloud"}
        endToEndEncrypted={app.context?.endToEndEncrypted ?? false}
      />
    </div>
  );
}
