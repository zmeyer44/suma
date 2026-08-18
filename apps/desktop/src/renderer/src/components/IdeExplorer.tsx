import { FileTree, useFileTree } from "@pierre/trees/react";
import { FilePlus, FolderPlus, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useSumaStore } from "../store";

/**
 * The IDE's file explorer (suma://terminal) — @pierre/trees over the
 * workspace listing that main's WorkspaceFsService walked. The tree is
 * path-first: the store hands it workspace-relative path strings, and
 * selection hands the same strings back, which is exactly the currency the
 * editor and `workspace:readFile` speak.
 *
 * New File / New Folder use the library's inline-naming flow (VS Code's
 * pattern): a placeholder row is added and put straight into renaming with
 * removeIfCanceled, so Esc — or committing an empty name — removes it and
 * creates nothing. The placeholder's leaf name is a single space: the rename
 * input renders it looking empty, and an untouched commit trims to "" and is
 * treated as a cancel by the library rather than a rename.
 */

/**
 * The tree renders in a shadow root, themed through its --trees-*-override
 * custom properties (which pierce shadow boundaries). Values map straight
 * onto the chrome's palette so the explorer reads as part of the app — and
 * follows theme changes live, since these are var() references, not
 * resolved colors.
 */
const TREE_VARS = {
  height: "100%",
  "--trees-bg-override": "var(--color-panel)",
  "--trees-bg-muted-override": "var(--color-raised)",
  "--trees-fg-override": "var(--color-text)",
  "--trees-fg-muted-override": "var(--color-muted)",
  "--trees-border-color-override": "var(--color-hairline)",
  "--trees-accent-override": "var(--color-accent)",
  "--trees-selected-bg-override":
    "color-mix(in srgb, var(--color-ink) 10%, transparent)",
  "--trees-font-family-override": "var(--font-sans)",
  "--trees-font-size-override": "12px",
} as CSSProperties;

const HEADER_BUTTON_CLASS =
  "grid size-5 shrink-0 cursor-pointer place-items-center rounded text-faint hover:bg-ink/8 hover:text-text disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent";

export function IdeExplorer() {
  const tree = useSumaStore((s) => s.workspaceTree);
  const openFiles = useSumaStore((s) => s.ideOpenFiles);
  const openIdeFile = useSumaStore((s) => s.openIdeFile);
  const refreshWorkspaceTree = useSumaStore((s) => s.refreshWorkspaceTree);
  const createIdeFile = useSumaStore((s) => s.createIdeFile);
  const createIdeFolder = useSumaStore((s) => s.createIdeFolder);
  const pushToast = useSumaStore((s) => s.pushToast);
  const auth = useSumaStore((s) => s.auth);
  const machine = useSumaStore((s) => s.machine);
  const workspaceSource = useSumaStore((s) => s.workspaceSource);
  const workspaceConnected = useSumaStore((s) => s.workspaceConnected);

  // Cloud mode before the VM link is up: the simulator's tree is about to be
  // swapped out, so showing it would present files that are about to vanish.
  const awaitingComputer =
    auth.computeMode === "cloud" &&
    (workspaceSource !== "remote" || workspaceConnected === false);
  const computerIsAnotherMac =
    auth.computeMode === "local" &&
    (workspaceConnected === false ||
      (machine?.machineId === null && machine.state === "suspended"));
  const mutationsUnavailable =
    workspaceConnected === false || computerIsAnotherMac;

  // The active create placeholder's canonical model path (trailing slash for
  // a folder), or null when no inline naming is in flight. `creating` mirrors
  // it as state so the tree renders (and background resets pause) while the
  // input is open.
  const pendingRef = useRef<string | null>(null);
  const [creating, setCreating] = useState(false);

  // useFileTree options are creation-time only ("later option changes do not
  // update the model"), so callbacks read refs and data updates go through
  // model.resetPaths below.
  const { model } = useFileTree({
    paths: tree?.paths ?? [],
    initialExpansion: "closed",
    search: true,
    renaming: {
      // Inline naming exists only for the create placeholder: renaming real
      // entries (F2) isn't wired to workspace:rename yet, and letting the
      // model rename what the disk doesn't would lie until the next refresh.
      canRename: (item) =>
        pendingRef.current !== null &&
        (item.path === pendingRef.current ||
          `${item.path}/` === pendingRef.current),
      onError: (error) => toastRef.current(error, "error"),
      onRename: (event) => void commitRef.current(event),
    },
    onSelectionChange: (paths) => {
      const path = paths[0];
      // The placeholder gets selected by startRenaming; it is not a real
      // file, so it must never reach the editor.
      if (path === undefined || pendingRef.current !== null) return;
      const item = modelRef.current?.getItem(path);
      if (item !== null && item !== undefined && !item.isDirectory()) {
        openRef.current(path);
      }
    },
  });
  const modelRef = useRef(model);
  modelRef.current = model;
  const openRef = useRef(openIdeFile);
  openRef.current = openIdeFile;
  const toastRef = useRef(pushToast);
  toastRef.current = pushToast;

  const commitCreate = async (event: {
    sourcePath: string;
    destinationPath: string;
    isFolder: boolean;
  }): Promise<void> => {
    pendingRef.current = null;
    const ok = event.isFolder
      ? await createIdeFolder(event.destinationPath)
      : await createIdeFile(event.destinationPath);
    if (!ok) {
      // The library moved the placeholder to its typed name before we could
      // fail; take the phantom row back out.
      modelRef.current.remove(
        event.isFolder ? `${event.destinationPath}/` : event.destinationPath,
        event.isFolder ? { recursive: true } : undefined,
      );
    }
    setCreating(false);
  };
  const commitRef = useRef(commitCreate);
  commitRef.current = commitCreate;

  // Esc, blur, or an empty name makes the library remove the placeholder
  // itself (removeIfCanceled) — observe it to leave create mode.
  useEffect(
    () =>
      model.onMutation("remove", (event) => {
        const pending = pendingRef.current;
        if (
          pending !== null &&
          (event.path === pending || `${event.path}/` === pending)
        ) {
          pendingRef.current = null;
          setCreating(false);
        }
      }),
    [model],
  );

  const beginCreate = (kind: "file" | "folder"): void => {
    if (pendingRef.current !== null) return;
    // VS Code semantics: create inside the selected folder, beside the
    // selected file, or at the root when nothing is selected.
    const anchor = model.getSelectedPaths()[0] ?? model.getFocusedPath();
    const anchorItem = anchor == null ? null : model.getItem(anchor);
    let dir = "";
    if (anchorItem !== null) {
      const canonical = anchorItem.getPath();
      dir = anchorItem.isDirectory()
        ? canonical.endsWith("/")
          ? canonical
          : `${canonical}/`
        : canonical.slice(0, canonical.lastIndexOf("/") + 1);
    }
    const placeholder = kind === "folder" ? `${dir} /` : `${dir} `;
    pendingRef.current = placeholder;
    setCreating(true);
    let renaming = false;
    try {
      model.add(placeholder);
      renaming = model.startRenaming(placeholder, { removeIfCanceled: true });
      // The placeholder sorts with its siblings, which in a large listing can
      // put the input below the fold — where "nothing happens" is all the
      // user would see.
      if (renaming) model.scrollToPath(placeholder, { offset: "center" });
    } finally {
      // A throw or a false return must never strand the pending marker: it
      // gates every later click, so leaking it bricks both buttons.
      if (!renaming) {
        try {
          model.remove(
            placeholder,
            kind === "folder" ? { recursive: true } : undefined,
          );
        } catch {
          // The add itself failed — there is nothing to take back out.
        }
        pendingRef.current = null;
        setCreating(false);
      }
    }
  };

  // Closing an editor tab deselects its row, so clicking the same file again
  // is a fresh selection change and reopens it.
  useEffect(() => {
    for (const path of model.getSelectedPaths()) {
      const item = model.getItem(path);
      if (item !== null && !item.isDirectory() && !openFiles.includes(path)) {
        item.deselect();
      }
    }
  }, [openFiles, model]);

  /** Store refreshes swap the whole array, so identity is the change signal.
   *  Resets pause while inline naming is open — resetPaths would drop the
   *  placeholder mid-typing — and the effect re-runs when `creating` clears. */
  const renderedPaths = useRef(tree?.paths ?? null);
  useEffect(() => {
    if (tree === null || tree.paths === renderedPaths.current || creating)
      return;
    renderedPaths.current = tree.paths;
    model.resetPaths(tree.paths);
  }, [tree, model, creating]);

  const rootName = tree === null ? null : (tree.root.split("/").at(-1) ?? "/");

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-hairline px-3 py-2">
        <span className="text-[11px] font-medium tracking-wide text-muted uppercase">
          Explorer
        </span>
        {rootName !== null ? (
          <span
            className="min-w-0 truncate text-[11px] text-faint"
            title={tree?.root}
          >
            {rootName}
          </span>
        ) : null}
        <span className="flex-1" />
        <button
          type="button"
          aria-label="New file"
          title="New file"
          disabled={mutationsUnavailable || tree === null}
          onClick={() => beginCreate("file")}
          className={HEADER_BUTTON_CLASS}
        >
          <FilePlus className="size-3" aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label="New folder"
          title="New folder"
          disabled={mutationsUnavailable || tree === null}
          onClick={() => beginCreate("folder")}
          className={HEADER_BUTTON_CLASS}
        >
          <FolderPlus className="size-3" aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label="Refresh file tree"
          title="Refresh file tree"
          disabled={mutationsUnavailable}
          onClick={() => void refreshWorkspaceTree()}
          className={HEADER_BUTTON_CLASS}
        >
          <RefreshCw className="size-3" aria-hidden="true" />
        </button>
      </div>
      {tree !== null && tree.truncated ? (
        <div className="shrink-0 bg-warn/12 px-3 py-1 text-[10.5px] text-warn">
          Large workspace — the listing is truncated.
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
        {computerIsAnotherMac ? (
          <p className="p-3 text-[12px] text-faint">
            Your computer is another Mac. Access from this device isn’t
            available yet.
          </p>
        ) : awaitingComputer ? (
          <p className="p-3 text-[12px] text-faint">
            Connecting to your computer…
          </p>
        ) : tree === null ? (
          <p className="p-3 text-[12px] text-faint">Loading workspace…</p>
        ) : tree.paths.length === 0 && !creating ? (
          <p className="p-3 text-[12px] text-faint">The workspace is empty.</p>
        ) : (
          <FileTree model={model} style={TREE_VARS} />
        )}
      </div>
    </div>
  );
}
