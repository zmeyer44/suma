import { Editor, type EditorOptions } from "@pierre/diffs/edit";
import {
  EditProvider,
  File,
  type FileContents,
  type FileOptions,
} from "@pierre/diffs/react";
import { Save, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import type { WorkspaceFile } from "../../../shared/ipc";
import { cn } from "../lib/cn";
import { formatBytes } from "../lib/format";
import { ideBuffers } from "../lib/ide";
import { IdeAudioPlayer } from "./IdeAudioPlayer";
import { useSumaStore } from "../store";

/**
 * The IDE's editor pane (suma://terminal) — @pierre/diffs' `File` surface in
 * edit mode, one tab per open workspace file.
 *
 * Text lives in lib/ide's buffer map, not in state: the editor owns the
 * document while typing (re-rendering `File` with new contents would fight
 * it), and the buffers must survive this page unmounting on tab switches.
 * The store carries only the file LIST, the active path, and dirty booleans.
 *
 * Images and audio are the non-text things the pane renders: main sniffs both
 * and sends an image as a data URL, audio as a suma-workspace:// stream URL.
 * Neither takes a buffer, so neither can be dirty or saved.
 *
 * Theming: syntax colors come from the library's own Shiki theme pair
 * (pierre-dark/pierre-light) following the chrome's data-theme, while the
 * surfaces underneath are overridden to the app palette so the pane sits on
 * the same ground as the terminal below it. The highlighter is pinned to
 * shiki-js — the chrome's CSP (`script-src 'self'`) has no
 * 'wasm-unsafe-eval', so the WASM engine would never instantiate.
 */

/** App-palette overrides + fonts, inherited into the diffs DOM. */
const EDITOR_VARS = {
  "--diffs-font-family": "var(--font-mono)",
  "--diffs-font-size": "12px",
  "--diffs-bg-context-override": "var(--color-bg)",
  "--diffs-bg-context-gutter-override": "var(--color-bg)",
} as CSSProperties;

/** The chrome sets data-theme on <html>; absent means the dark default. */
function readAppThemeType(): "dark" | "light" {
  return document.documentElement.dataset["theme"] === "light"
    ? "light"
    : "dark";
}

function useAppThemeType(): "dark" | "light" {
  const [themeType, setThemeType] = useState(readAppThemeType);
  useEffect(() => {
    const observer = new MutationObserver(() =>
      setThemeType(readAppThemeType()),
    );
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);
  return themeType;
}

function basename(path: string): string {
  return path.split("/").at(-1) ?? path;
}

/** "image/png" → "PNG"; the caption wants the format, not the media type. */
function formatLabel(mime: string): string {
  return (mime.split("/").at(-1) ?? mime).replace("x-", "").toUpperCase();
}

function unreadableNotice(
  file: Extract<WorkspaceFile, { kind: "unreadable" }>,
): string {
  if (file.reason === "too-large")
    return `${file.path} is too large to open here.`;
  if (file.reason === "unsupported") return `${file.path} is not a file.`;
  return `${file.path} is binary — nothing to show.`;
}

/** Read-only image view: fits the pane, with format/size/dimensions beneath. */
function ImageView({
  file,
}: {
  file: Extract<WorkspaceFile, { kind: "image" }>;
}) {
  const [dimensions, setDimensions] = useState<string | null>(null);
  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center gap-3 p-6">
      <img
        src={file.dataUrl}
        alt={basename(file.path)}
        onLoad={(e) =>
          setDimensions(
            `${e.currentTarget.naturalWidth}×${e.currentTarget.naturalHeight}`,
          )
        }
        className="max-h-full min-h-0 max-w-full rounded-md object-contain"
      />
      <p className="shrink-0 text-[11px] text-faint">
        {[formatLabel(file.mime), dimensions, formatBytes(file.bytes)]
          .filter((part) => part !== null)
          .join(" · ")}
      </p>
    </div>
  );
}

export function IdeEditor() {
  const openFiles = useSumaStore((s) => s.ideOpenFiles);
  const activeFile = useSumaStore((s) => s.ideActiveFile);
  const dirty = useSumaStore((s) => s.ideDirty);
  const setIdeActiveFile = useSumaStore((s) => s.setIdeActiveFile);
  const closeIdeFile = useSumaStore((s) => s.closeIdeFile);
  const setIdeFileDirty = useSumaStore((s) => s.setIdeFileDirty);
  const readIdeFile = useSumaStore((s) => s.readIdeFile);
  const saveIdeFile = useSumaStore((s) => s.saveIdeFile);

  const themeType = useAppThemeType();
  const [loaded, setLoaded] = useState<WorkspaceFile | null>(null);

  useEffect(() => {
    if (activeFile === null) {
      setLoaded(null);
      return;
    }
    // An existing buffer wins over disk — it may hold unsaved edits.
    const buffer = ideBuffers.get(activeFile);
    if (buffer !== undefined) {
      setLoaded({ path: activeFile, kind: "text", contents: buffer.current });
      return;
    }
    let cancelled = false;
    void readIdeFile(activeFile).then((file) => {
      if (cancelled || file === undefined) return;
      if (file.kind === "text") {
        ideBuffers.set(activeFile, {
          saved: file.contents,
          current: file.contents,
        });
      }
      setLoaded(file);
    });
    return () => {
      cancelled = true;
    };
  }, [activeFile, readIdeFile]);

  const save = useCallback(
    async (path: string): Promise<void> => {
      const buffer = ideBuffers.get(path);
      if (buffer === undefined || buffer.current === buffer.saved) return;
      const contents = buffer.current;
      if (await saveIdeFile(path, contents)) {
        buffer.saved = contents;
        setIdeFileDirty(path, buffer.current !== contents);
      }
    },
    [saveIdeFile, setIdeFileDirty],
  );
  const saveRef = useRef(save);
  saveRef.current = save;

  // editorOptions reach the Editor at creation time only (EditProvider
  // factory), so the callbacks route through refs to stay current.
  const dirtyRef = useRef<(file: FileContents) => void>(() => undefined);
  dirtyRef.current = (file) => {
    const path = file.cacheKey;
    if (typeof path !== "string") return;
    const buffer = ideBuffers.get(path);
    if (buffer === undefined) return;
    buffer.current = file.contents;
    setIdeFileDirty(path, buffer.current !== buffer.saved);
  };

  const editorOptions = useMemo<EditorOptions<undefined>>(
    () => ({
      onChange: (file) => dirtyRef.current(file),
      // Electron: the native clipboard API is the recommended provider.
      clipboard: { readText: () => navigator.clipboard.readText() },
    }),
    [],
  );

  const createEditor = useCallback(
    (options: EditorOptions<undefined>) => new Editor(options),
    [],
  );

  const fileOptions = useMemo<FileOptions<undefined>>(
    () => ({
      theme: { dark: "pierre-dark", light: "pierre-light" },
      themeType,
      disableFileHeader: true,
      overflow: "scroll",
      preferredHighlighter: "shiki-js",
    }),
    [themeType],
  );

  const activeDirty = activeFile !== null && (dirty[activeFile] ?? false);

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-bg"
      style={EDITOR_VARS}
      onKeyDownCapture={(e) => {
        if (!e.metaKey || e.key !== "s") return;
        e.preventDefault();
        if (activeFile !== null) void saveRef.current(activeFile);
      }}
    >
      <div className="flex shrink-0 items-center gap-1 border-b border-hairline bg-panel px-2 py-1.5">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {openFiles.map((path) => (
            <div
              key={path}
              className={cn(
                "flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1 text-[12px]",
                path === activeFile
                  ? "bg-ink/10 text-text"
                  : "text-muted hover:bg-ink/5",
              )}
            >
              <button
                type="button"
                onClick={() => setIdeActiveFile(path)}
                className="cursor-pointer"
                title={path}
              >
                {(dirty[path] ?? false) ? (
                  <span className="mr-1 text-warn">●</span>
                ) : null}
                {basename(path)}
              </button>
              <button
                type="button"
                aria-label={`Close ${basename(path)}`}
                onClick={() => closeIdeFile(path)}
                className="grid size-3.5 cursor-pointer place-items-center rounded text-faint hover:bg-ink/12 hover:text-text"
              >
                <X className="size-2.5" aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
        {activeDirty ? (
          <button
            type="button"
            aria-label="Save file (⌘S)"
            title="Save file (⌘S)"
            onClick={() => {
              if (activeFile !== null) void saveRef.current(activeFile);
            }}
            className="grid size-6 shrink-0 cursor-pointer place-items-center rounded-md text-muted hover:bg-ink/8 hover:text-text"
          >
            <Save className="size-3.5" aria-hidden="true" />
          </button>
        ) : null}
      </div>

      <div className="relative min-h-0 flex-1 overflow-y-auto">
        {openFiles.length === 0 ? (
          <p className="p-4 text-[12px] text-faint">
            No file open — pick one in the explorer.
          </p>
        ) : loaded === null ? null : loaded.kind === "image" ? (
          <ImageView key={loaded.path} file={loaded} />
        ) : loaded.kind === "audio" ? (
          <IdeAudioPlayer key={loaded.path} file={loaded} />
        ) : loaded.kind === "unreadable" ? (
          <p className="p-4 text-[12px] text-faint">
            {unreadableNotice(loaded)}
          </p>
        ) : (
          <EditProvider createEditor={createEditor}>
            <File
              // Keyed per path: each file gets a fresh Editor; the buffer map
              // preserves its text across switches.
              key={loaded.path}
              file={{
                name: loaded.path,
                contents: loaded.contents,
                cacheKey: loaded.path,
              }}
              edit
              editorOptions={editorOptions}
              options={fileOptions}
              disableWorkerPool
            />
          </EditProvider>
        )}
      </div>
    </div>
  );
}
