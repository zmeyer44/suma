import { useState } from "react";
import { cn } from "../lib/cn";
import { formatBytes, formatCount } from "../lib/format";
import type { TreeRow } from "../lib/tree";
import { ChevronIcon, FileIcon, FolderIcon } from "./Icons";

function Row({
  row,
  selected,
  onSelect,
  onToggle,
}: {
  row: TreeRow;
  selected: boolean;
  onSelect: (path: string) => void;
  onToggle: (path: string) => void;
}) {
  const { node, depth } = row;
  const isDir = node.kind === "dir";
  const subtitle = isDir
    ? `${formatCount(node.fileCount, "file")} · ${formatBytes(node.sizeBytes)}`
    : formatBytes(node.sizeBytes);

  return (
    <button
      type="button"
      onClick={() => {
        onSelect(node.path);
        if (isDir) onToggle(node.path);
      }}
      aria-expanded={isDir ? row.expanded : undefined}
      aria-current={selected ? "true" : undefined}
      title={node.path}
      className={cn(
        "flex w-full cursor-pointer items-center gap-1.5 rounded-lg py-1.5 pr-2 text-left",
        selected ? "bg-accent/15 text-text" : "text-muted hover:bg-white/6 hover:text-text",
      )}
      style={{ paddingLeft: `${8 + depth * 14}px` }}
    >
      <span className="grid size-3 shrink-0 place-items-center text-faint">
        {isDir ? <ChevronIcon open={row.expanded} /> : null}
      </span>
      <span className={cn("shrink-0", isDir ? "text-accent/80" : "text-faint")}>
        {isDir ? <FolderIcon className="size-3.5" /> : <FileIcon className="size-3.5" />}
      </span>
      <span className="min-w-0 flex-1 truncate text-[12.5px]">{node.name}</span>
      <span className="shrink-0 text-[10.5px] tabular-nums text-faint">{subtitle}</span>
    </button>
  );
}

/**
 * The browse column. Dropping files here uploads them into the selected
 * directory — the same destination the Upload button uses, shown in the
 * footer so it is never a surprise.
 */
export function FileTree({
  rows,
  ready,
  selectedPath,
  uploadDir,
  softBlocked,
  onSelect,
  onToggle,
  onDropFiles,
}: {
  rows: readonly TreeRow[];
  ready: boolean;
  selectedPath: string | null;
  uploadDir: string;
  softBlocked: boolean;
  onSelect: (path: string) => void;
  onToggle: (path: string) => void;
  onDropFiles: (files: readonly File[]) => void;
}) {
  const [dragging, setDragging] = useState(false);

  return (
    <aside
      className={cn(
        "flex w-[300px] shrink-0 flex-col border-r border-hairline bg-panel",
        dragging && "outline outline-2 -outline-offset-2 outline-accent/60",
      )}
      onDragOver={(event) => {
        event.preventDefault();
        if (!softBlocked) setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        if (softBlocked) return;
        onDropFiles([...event.dataTransfer.files]);
      }}
    >
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {!ready ? (
          <p className="px-2 py-6 text-[12px] text-faint">Loading your files…</p>
        ) : rows.length === 0 ? (
          <p className="px-2 py-6 text-[12px] leading-relaxed text-faint">
            Nothing here yet. Upload a file, or download something over 50 MB from a public link and
            it will land here.
          </p>
        ) : (
          <nav className="flex flex-col gap-px" aria-label="Files">
            {rows.map((row) => (
              <Row
                key={row.node.path}
                row={row}
                selected={row.node.path === selectedPath}
                onSelect={onSelect}
                onToggle={onToggle}
              />
            ))}
          </nav>
        )}
      </div>
      <footer className="border-t border-hairline px-3 py-2 text-[10.5px] text-faint">
        {dragging ? "Drop to upload into " : "Uploads go to "}
        <span className="font-mono text-muted">{uploadDir}</span>
      </footer>
    </aside>
  );
}
