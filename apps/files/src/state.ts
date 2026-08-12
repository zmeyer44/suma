/**
 * All app state in one hook. The components below it are dumb on purpose:
 * every call that leaves this window goes through the injected bridge, and
 * every piece of derived state comes from a pure function in `lib/`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PRO_QUOTA_BYTES, type FileEntry, type QuotaState, type Transfer } from "@suma/protocol";
import type { FilesContext, SumaFilesBridge, UploadProgress } from "./bridge";
import { baseName, errorMessage } from "./lib/format";
import { imageMimeFor, planPreview, type PreviewPlan } from "./lib/preview";
import { admitUpload, summarizeQuota, type QuotaSummary } from "./lib/quota";
import {
  ancestorPaths,
  buildTree,
  findNode,
  flattenTree,
  joinPath,
  parentPath,
  ROOT_PATH,
  type TreeDir,
  type TreeRow,
} from "./lib/tree";

export type StatusTone = "info" | "ok" | "warn" | "danger";

export interface StatusMessage {
  tone: StatusTone;
  text: string;
}

export type PreviewState =
  | { status: "idle" }
  | { status: "loading"; path: string }
  | { status: "text"; path: string; text: string; truncated: boolean }
  | { status: "image"; path: string; url: string }
  | { status: "info"; path: string }
  | { status: "error"; path: string; message: string };

export interface FilesApp {
  ready: boolean;
  isMock: boolean;
  context: FilesContext | null;
  entries: FileEntry[];
  tree: TreeDir;
  rows: TreeRow[];
  expanded: ReadonlySet<string>;
  selectedPath: string | null;
  selectedEntry: FileEntry | null;
  previewPlan: PreviewPlan | null;
  preview: PreviewState;
  quota: QuotaState;
  quotaSummary: QuotaSummary;
  transfers: Transfer[];
  uploads: UploadProgress[];
  /** Directory new uploads land in, derived from the selection. */
  uploadDir: string;
  status: StatusMessage | null;
  downloadingPath: string | null;
  deletingPath: string | null;
  select: (path: string) => void;
  toggleDir: (path: string) => void;
  uploadFiles: (files: readonly File[]) => Promise<void>;
  download: (path: string) => Promise<void>;
  remove: (path: string) => Promise<void>;
  cancelTransfer: (transferId: string) => Promise<void>;
  clearStatus: () => void;
  clearFinishedUploads: () => void;
}

let uploadCounter = 0;

/** Correlation id for one upload. Not a security token — just unique enough. */
function newUploadId(): string {
  uploadCounter += 1;
  return `up_${Date.now().toString(36)}_${uploadCounter}_${Math.random().toString(36).slice(2, 8)}`;
}

function upsertUpload(list: readonly UploadProgress[], next: UploadProgress): UploadProgress[] {
  const index = list.findIndex((item) => item.uploadId === next.uploadId);
  if (index === -1) return [...list, next];
  const copy = [...list];
  copy[index] = next;
  return copy;
}

export function useFilesApp(bridge: SumaFilesBridge, isMock: boolean): FilesApp {
  const [ready, setReady] = useState(false);
  const [context, setContext] = useState<FilesContext | null>(null);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [quota, setQuota] = useState<QuotaState>({ usedBytes: 0, limitBytes: PRO_QUOTA_BYTES });
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [uploads, setUploads] = useState<UploadProgress[]>([]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [status, setStatus] = useState<StatusMessage | null>(null);
  const [preview, setPreview] = useState<PreviewState>({ status: "idle" });
  const [downloadingPath, setDownloadingPath] = useState<string | null>(null);
  const [deletingPath, setDeletingPath] = useState<string | null>(null);

  const firstLoad = useRef(true);
  const quotaRef = useRef<QuotaState>(quota);

  useEffect(() => {
    quotaRef.current = quota;
  }, [quota]);

  const refresh = useCallback(async () => {
    try {
      const [list, usage] = await Promise.all([bridge.list(ROOT_PATH), bridge.quota()]);
      setEntries(list);
      setQuota(usage);
      if (firstLoad.current) {
        firstLoad.current = false;
        const top = buildTree(list).children.filter((node) => node.kind === "dir");
        setExpanded(new Set(top.map((node) => node.path)));
      }
    } catch (error) {
      setStatus({ tone: "danger", text: errorMessage(error, "Couldn't load your files.") });
    }
  }, [bridge]);

  /* Initial load. */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [ctx, list] = await Promise.allSettled([bridge.context(), bridge.listTransfers()]);
      if (cancelled) return;
      if (ctx.status === "fulfilled") setContext(ctx.value);
      if (list.status === "fulfilled") setTransfers(list.value);
      await refresh();
      if (!cancelled) setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [bridge, refresh]);

  /* Live updates from the main process. */
  useEffect(() => {
    const offFiles = bridge.onFilesChanged(() => void refresh());
    const offTransfers = bridge.onTransfersUpdated((next) => setTransfers(next));
    const offUploads = bridge.onUploadProgress((progress) =>
      setUploads((prev) => upsertUpload(prev, progress)),
    );
    return () => {
      offFiles();
      offTransfers();
      offUploads();
    };
  }, [bridge, refresh]);

  const tree = useMemo(() => buildTree(entries), [entries]);
  const rows = useMemo(() => flattenTree(tree, expanded), [tree, expanded]);

  const selectedNode = useMemo(
    () => (selectedPath === null ? null : findNode(tree, selectedPath)),
    [tree, selectedPath],
  );
  const selectedEntry =
    selectedNode !== null && selectedNode.kind === "file" ? selectedNode.entry : null;
  const previewPlan = useMemo(
    () => (selectedEntry === null ? null : planPreview(selectedEntry)),
    [selectedEntry],
  );

  const uploadDir = useMemo(() => {
    if (selectedNode === null) return ROOT_PATH;
    return selectedNode.kind === "dir" ? selectedNode.path : parentPath(selectedNode.path);
  }, [selectedNode]);

  const quotaSummary = useMemo(() => summarizeQuota(quota), [quota]);

  /*
   * Preview loading, keyed on primitives rather than on the entry object: a
   * background refresh that returns the same file must not restart the read,
   * while a file whose bytes changed must.
   */
  const subjectPath = selectedEntry === null ? null : selectedEntry.path;
  const subjectHash = selectedEntry === null ? null : selectedEntry.fileHash;
  const subjectSize = selectedEntry === null ? 0 : selectedEntry.sizeBytes;
  const subjectType = selectedEntry === null ? null : selectedEntry.contentType;

  useEffect(() => {
    if (subjectPath === null) {
      setPreview({ status: "idle" });
      return;
    }
    // Not read, only depended on: new content behind the same path re-reads.
    void subjectHash;

    const path = subjectPath;
    const subject = { path, sizeBytes: subjectSize, contentType: subjectType };
    const plan = planPreview(subject);
    if (plan.kind === "none") {
      setPreview({ status: "info", path });
      return;
    }

    let cancelled = false;
    let objectUrl: string | null = null;
    setPreview({ status: "loading", path });

    void (async () => {
      try {
        const bytes = await bridge.read(path, plan.readBytes);
        if (cancelled) return;
        if (bytes === null) {
          setPreview({ status: "error", path, message: "This file is no longer in Files." });
          return;
        }
        if (plan.kind === "text") {
          setPreview({
            status: "text",
            path,
            text: new TextDecoder().decode(bytes.data),
            truncated: plan.truncated || bytes.truncated,
          });
          return;
        }
        const type = imageMimeFor(subject) ?? "application/octet-stream";
        objectUrl = URL.createObjectURL(new Blob([bytes.data], { type }));
        setPreview({ status: "image", path, url: objectUrl });
      } catch (error) {
        if (cancelled) return;
        setPreview({
          status: "error",
          path,
          message: errorMessage(error, "Couldn't read this file."),
        });
      }
    })();

    return () => {
      cancelled = true;
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
    };
  }, [bridge, subjectPath, subjectHash, subjectSize, subjectType]);

  const select = useCallback((path: string) => {
    setSelectedPath(path);
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const ancestor of ancestorPaths(path)) next.add(ancestor);
      return next;
    });
  }, []);

  const toggleDir = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  }, []);

  const uploadFiles = useCallback(
    async (files: readonly File[]) => {
      if (files.length === 0) return;
      const incoming = files.reduce((sum, file) => sum + file.size, 0);
      const admission = admitUpload(quotaRef.current, incoming);
      if (!admission.allowed) {
        setStatus({ tone: "warn", text: admission.message });
        return;
      }

      const dir = uploadDir;
      let uploaded = 0;
      for (const file of files) {
        const path = joinPath(dir, file.name);
        if (path === null) {
          setStatus({ tone: "danger", text: `"${file.name}" can't be used as a file name.` });
          continue;
        }
        const uploadId = newUploadId();
        const failed = (message: string): void => {
          setUploads((prev) =>
            upsertUpload(prev, {
              uploadId,
              path,
              sentBytes: 0,
              totalBytes: file.size,
              state: "failed",
              error: message,
            }),
          );
        };

        setUploads((prev) =>
          upsertUpload(prev, {
            uploadId,
            path,
            sentBytes: 0,
            totalBytes: file.size,
            state: "hashing",
            error: null,
          }),
        );

        try {
          const data = new Uint8Array(await file.arrayBuffer());
          const result = await bridge.upload({
            uploadId,
            path,
            contentType: file.type === "" ? null : file.type,
            data,
          });
          if (!result.ok) {
            failed(result.message);
            setStatus({ tone: result.reason === "quota" ? "warn" : "danger", text: result.message });
            continue;
          }
          uploaded += 1;
          setSelectedPath(result.entry.path);
        } catch (error) {
          const message = errorMessage(error, `Couldn't upload ${file.name}.`);
          failed(message);
          setStatus({ tone: "danger", text: message });
        }
      }

      if (uploaded > 0) {
        setStatus({
          tone: "ok",
          text: uploaded === 1 ? "Uploaded 1 file." : `Uploaded ${uploaded} files.`,
        });
      }
      await refresh();
    },
    [bridge, refresh, uploadDir],
  );

  const download = useCallback(
    async (path: string) => {
      setDownloadingPath(path);
      try {
        const result = await bridge.download(path);
        setStatus(
          result.ok
            ? { tone: "ok", text: `Saved to ${result.savePath}` }
            : { tone: "danger", text: result.message },
        );
      } catch (error) {
        setStatus({ tone: "danger", text: errorMessage(error, "Couldn't download that file.") });
      } finally {
        setDownloadingPath(null);
      }
    },
    [bridge],
  );

  const remove = useCallback(
    async (path: string) => {
      setDeletingPath(path);
      try {
        const result = await bridge.remove(path);
        if (result.ok) {
          setStatus({ tone: "ok", text: `Deleted ${baseName(path)}.` });
          setSelectedPath((current) => (current === path ? null : current));
        } else {
          setStatus({ tone: "danger", text: result.message });
        }
      } catch (error) {
        setStatus({ tone: "danger", text: errorMessage(error, "Couldn't delete that file.") });
      } finally {
        setDeletingPath(null);
        await refresh();
      }
    },
    [bridge, refresh],
  );

  const cancelTransfer = useCallback(
    async (transferId: string) => {
      try {
        await bridge.cancelTransfer(transferId);
        setTransfers(await bridge.listTransfers());
      } catch (error) {
        setStatus({ tone: "danger", text: errorMessage(error, "Couldn't cancel that transfer.") });
      }
    },
    [bridge],
  );

  const clearStatus = useCallback(() => setStatus(null), []);
  const clearFinishedUploads = useCallback(() => {
    setUploads((prev) =>
      prev.filter((item) => item.state !== "completed" && item.state !== "failed"),
    );
  }, []);

  return {
    ready,
    isMock,
    context,
    entries,
    tree,
    rows,
    expanded,
    selectedPath,
    selectedEntry,
    previewPlan,
    preview,
    quota,
    quotaSummary,
    transfers,
    uploads,
    uploadDir,
    status,
    downloadingPath,
    deletingPath,
    select,
    toggleDir,
    uploadFiles,
    download,
    remove,
    cancelTransfer,
    clearStatus,
    clearFinishedUploads,
  };
}
