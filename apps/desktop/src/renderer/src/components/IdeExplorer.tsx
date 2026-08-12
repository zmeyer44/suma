import { FileTree, useFileTree } from "@pierre/trees/react";
import { RefreshCw } from "lucide-react";
import { useEffect, useRef, type CSSProperties } from "react";
import { useSumaStore } from "../store";

/**
 * The IDE's file explorer (suma://terminal) — @pierre/trees over the
 * workspace listing that main's WorkspaceFsService walked. The tree is
 * path-first: the store hands it workspace-relative path strings, and
 * selection hands the same strings back, which is exactly the currency the
 * editor and `workspace:readFile` speak.
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

export function IdeExplorer() {
  const tree = useSumaStore((s) => s.workspaceTree);
  const openFiles = useSumaStore((s) => s.ideOpenFiles);
  const openIdeFile = useSumaStore((s) => s.openIdeFile);
  const refreshWorkspaceTree = useSumaStore((s) => s.refreshWorkspaceTree);

  // useFileTree options are creation-time only ("later option changes do not
  // update the model"), so callbacks read refs and data updates go through
  // model.resetPaths below.
  const { model } = useFileTree({
    paths: tree?.paths ?? [],
    initialExpansion: "closed",
    search: true,
    onSelectionChange: (paths) => {
      const path = paths[0];
      if (path === undefined) return;
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

  /** Store refreshes swap the whole array, so identity is the change signal. */
  const renderedPaths = useRef(tree?.paths ?? null);
  useEffect(() => {
    if (tree === null || tree.paths === renderedPaths.current) return;
    renderedPaths.current = tree.paths;
    model.resetPaths(tree.paths);
  }, [tree, model]);

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
          aria-label="Refresh file tree"
          title="Refresh file tree"
          onClick={() => void refreshWorkspaceTree()}
          className="grid size-5 shrink-0 cursor-pointer place-items-center rounded text-faint hover:bg-ink/8 hover:text-text"
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
        {tree === null ? (
          <p className="p-3 text-[12px] text-faint">Loading workspace…</p>
        ) : tree.paths.length === 0 ? (
          <p className="p-3 text-[12px] text-faint">The workspace is empty.</p>
        ) : (
          <FileTree model={model} style={TREE_VARS} />
        )}
      </div>
    </div>
  );
}
