/**
 * WorkspaceFsService — the filesystem behind the suma://terminal IDE
 * (explorer + editor), served over the agent link's vfs channel.
 *
 * This is the "one virtual computer" seam: the IDE reads and writes whatever
 * machine the terminal talks to — the Fly VM's ~/cloud through
 * TcpAgentClient, or the local shared folder through SimAgent's LocalVfs.
 * The service itself no longer touches the disk; it turns renderer requests
 * into vfs frames and vfs answers into the renderer's Workspace* shapes.
 *
 * Trust model unchanged: the renderer only ever holds workspace-RELATIVE
 * paths. Every path is normalized here and refused if it escapes — a
 * chrome-renderer compromise must not become arbitrary file access on
 * whichever machine is behind the link. An optional scope prefixes every
 * path with the active space's folder, so the explorer sees one space's
 * tree, never the whole root.
 */

import {
  normalizeVfsPath,
  VFS_MAX_READ_BYTES,
  type VfsResponse,
} from "@suma/protocol";
import type { AgentLink } from "./compute/agent-client";
import type {
  WorkspaceConnectionStatus,
  WorkspaceFile,
  WorkspaceTree,
} from "../shared/ipc";
import { workspaceMediaUrl } from "./workspace-media";
import {
  looksBinary,
  sniffAudioMime,
  sniffImageMime,
  SNIFF_BYTES,
} from "./workspace-sniff";

/** Editor cap — matches what a text editor can usefully hold. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/**
 * Images ride to the renderer as a base64 data URL, so they get their own,
 * larger cap — which is also the vfs single-read cap, so one read suffices.
 */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

function unwrap(
  resp: VfsResponse,
  context: string,
): Exclude<VfsResponse, { t: "error" }> {
  if (resp.t === "error") throw new Error(`${context}: ${resp.message}`);
  return resp;
}

export class WorkspaceFsService {
  private link: AgentLink | null = null;
  /**
   * Workspace-relative folder every path is confined under ("" = the whole
   * root). The provider is read per call: the active space can change at any
   * moment and the next request must land in the new folder.
   */
  private scope: () => string = () => "";

  /** Wire the service to the (switchable) agent link at service start. */
  bind(link: AgentLink, scope?: () => string): void {
    this.link = link;
    if (scope !== undefined) this.scope = scope;
  }

  unbind(): void {
    this.link = null;
  }

  /** Current transport identity, retained for renderer hydration. The push
   * event can happen before chrome subscribes; this snapshot makes the same
   * state queryable without touching the filesystem. */
  connectionStatus(activeSpaceId: string | null): WorkspaceConnectionStatus {
    const link = this.link;
    return {
      source: link?.kind === "remote" ? "remote" : "sim",
      connected: link?.connected() ?? false,
      activeSpaceId,
    };
  }

  /** Display label for the workspace root (never a path the renderer resolves). */
  rootLabel(): string {
    const scope = this.scope();
    const base = this.link?.vfsRootLabel() ?? "";
    return scope === "" ? base : `${base}/${scope}`;
  }

  async tree(): Promise<WorkspaceTree> {
    const base = this.scopedRoot();
    let resp = await this.vfs().vfs({ t: "vfs.tree", path: base });
    if (resp.t === "error" && resp.code === "vfs_not_found") {
      // First visit: the scope folder (or a fresh machine's root) does not
      // exist yet. Create it and retry once — an empty tree, not an error.
      unwrap(
        await this.vfs().vfs({ t: "vfs.mkdir", path: base }),
        "creating workspace",
      );
      resp = await this.vfs().vfs({ t: "vfs.tree", path: base });
    }
    const paths = unwrap(resp, "listing workspace");
    if (paths.t !== "vfs.paths")
      throw new Error("listing workspace: unexpected vfs answer");
    const prefix = base === "/" ? "/" : `${base}/`;
    return {
      root: this.rootLabel(),
      paths: paths.paths
        .filter((p) => p.startsWith(prefix))
        .map((p) => p.slice(prefix.length)),
      truncated: paths.truncated,
    };
  }

  /**
   * Identify the file from its head first, then read only what the answer
   * needs: audio never crosses IPC (the player streams it over
   * suma-workspace://), while images and text are read whole under their caps.
   */
  /** Capture the active workspace scope for a multi-call operation. */
  captureScope(): string {
    return this.scopedRoot();
  }

  async read(rel: string, scopeRoot?: string): Promise<WorkspaceFile> {
    const wire = this.toVfsPath(rel, true, scopeRoot);
    const info = unwrap(
      await this.vfs().vfs({ t: "vfs.stat", path: wire }),
      `reading ${rel}`,
    );
    if (info.t !== "vfs.info")
      throw new Error(`reading ${rel}: unexpected vfs answer`);
    if (info.entry.kind !== "file") {
      return { path: rel, kind: "unreadable", reason: "unsupported" };
    }
    const size = info.entry.sizeBytes;
    const head = await this.readSlice(
      wire,
      0,
      Math.min(SNIFF_BYTES, size),
      rel,
    );

    const audioMime = sniffAudioMime(head, rel);
    if (audioMime !== null) {
      return {
        path: rel,
        kind: "audio",
        url: workspaceMediaUrl(rel),
        mime: audioMime,
        bytes: size,
      };
    }

    const imageMime = sniffImageMime(head);
    if (imageMime !== null) {
      if (size > MAX_IMAGE_BYTES) {
        return { path: rel, kind: "unreadable", reason: "too-large" };
      }
      const buffer = await this.readSlice(wire, 0, size, rel);
      return {
        path: rel,
        kind: "image",
        dataUrl: `data:${imageMime};base64,${buffer.toString("base64")}`,
        mime: imageMime,
        bytes: size,
      };
    }

    if (size > MAX_FILE_BYTES) {
      return { path: rel, kind: "unreadable", reason: "too-large" };
    }
    const buffer = await this.readSlice(wire, 0, size, rel);
    if (looksBinary(buffer)) {
      return { path: rel, kind: "unreadable", reason: "binary" };
    }
    return { path: rel, kind: "text", contents: buffer.toString("utf8") };
  }

  async write(rel: string, contents: string): Promise<{ ok: true }> {
    const dataB64 = Buffer.from(contents, "utf8").toString("base64");
    unwrap(
      await this.vfs().vfs({
        t: "vfs.write",
        path: this.toVfsPath(rel, false),
        dataB64,
      }),
      `saving ${rel}`,
    );
    return { ok: true };
  }

  /**
   * Exact compare-and-replace for assistant edits. `wire` is captured before
   * the request, so an active-space switch cannot redirect the write after
   * the caller read from a different scope. The agent performs the compare
   * and atomic rename under its mutation lock; concurrent VFS editor or
   * second-assistant writes therefore fail with vfs_conflict.
   */
  async replace(
    rel: string,
    expectedContents: string,
    contents: string,
    scopeRoot?: string,
  ): Promise<{ ok: true }> {
    const wire = this.toVfsPath(rel, false, scopeRoot);
    unwrap(
      await this.vfs().vfs({
        t: "vfs.replace",
        path: wire,
        expectedDataB64: Buffer.from(expectedContents, "utf8").toString(
          "base64",
        ),
        dataB64: Buffer.from(contents, "utf8").toString("base64"),
      }),
      `editing ${rel}`,
    );
    return { ok: true };
  }

  async mkdir(rel: string): Promise<{ ok: true }> {
    unwrap(
      await this.vfs().vfs({ t: "vfs.mkdir", path: this.toVfsPath(rel) }),
      `creating ${rel}`,
    );
    return { ok: true };
  }

  async remove(rel: string, recursive: boolean): Promise<{ ok: true }> {
    unwrap(
      await this.vfs().vfs({
        t: "vfs.delete",
        path: this.toVfsPath(rel, false),
        recursive,
      }),
      `deleting ${rel}`,
    );
    return { ok: true };
  }

  async rename(fromRel: string, toRel: string): Promise<{ ok: true }> {
    unwrap(
      await this.vfs().vfs({
        t: "vfs.rename",
        from: this.toVfsPath(fromRel, false),
        to: this.toVfsPath(toRel, false),
      }),
      `renaming ${fromRel}`,
    );
    return { ok: true };
  }

  /* --------------------- media streaming (suma-workspace://) --------------------- */

  /** Size of a workspace file, or null when it is missing or not a file. */
  async mediaSize(rel: string): Promise<number | null> {
    const resp = await this.vfs().vfs({
      t: "vfs.stat",
      path: this.toVfsPath(rel),
    });
    if (resp.t !== "vfs.info" || resp.entry.kind !== "file") return null;
    return resp.entry.sizeBytes;
  }

  /**
   * One bounded slice of a workspace file, for the media protocol's paged
   * streaming. `length` may exceed the vfs single-read cap by one page at
   * most — callers page with `nextMediaPage`.
   */
  async mediaSlice(
    rel: string,
    offset: number,
    length: number,
  ): Promise<Buffer> {
    return this.readSlice(this.toVfsPath(rel), offset, length, rel);
  }

  /* ------------------------------ internals ------------------------------ */

  private vfs(): AgentLink {
    if (this.link === null) throw new Error("workspace is not connected yet");
    return this.link;
  }

  private scopedRoot(): string {
    const scope = this.scope();
    if (scope === "") return "/";
    const normalized = normalizeVfsPath(scope);
    if (normalized === null || normalized === "/") {
      throw new Error(`workspace scope is invalid: ${scope}`);
    }
    return normalized;
  }

  /**
   * Map a renderer-supplied relative path onto the vfs wire, under the
   * scope. Same trust model as ever: absolute paths and escapes are refused
   * with the messages the store already surfaces.
   */
  private toVfsPath(
    rel: string,
    allowWorkspaceRoot = true,
    scopeRoot?: string,
  ): string {
    if (rel.startsWith("/")) throw new Error(`absolute path refused: ${rel}`);
    const normalized = normalizeVfsPath(rel);
    if (normalized === null) throw new Error(`path escapes workspace: ${rel}`);
    if (!allowWorkspaceRoot && normalized === "/") {
      throw new Error(`workspace root refused: ${rel}`);
    }
    const base = scopeRoot ?? this.scopedRoot();
    if (base === "/") return normalized;
    return normalized === "/" ? base : `${base}${normalized}`;
  }

  /** Read exactly [offset, offset+length) in vfs-cap pages. */
  private async readSlice(
    wire: string,
    offset: number,
    length: number,
    rel: string,
  ): Promise<Buffer> {
    if (length === 0) return Buffer.alloc(0);
    const parts: Buffer[] = [];
    let cursor = offset;
    const end = offset + length;
    while (cursor < end) {
      const want = Math.min(VFS_MAX_READ_BYTES, end - cursor);
      const resp = unwrap(
        await this.vfs().vfs({
          t: "vfs.read",
          path: wire,
          offset: cursor,
          length: want,
        }),
        `reading ${rel}`,
      );
      if (resp.t !== "vfs.data")
        throw new Error(`reading ${rel}: unexpected vfs answer`);
      const bytes = Buffer.from(resp.dataB64, "base64");
      parts.push(bytes);
      cursor += bytes.byteLength;
      if (resp.eof || bytes.byteLength === 0) break;
    }
    return Buffer.concat(parts);
  }
}
