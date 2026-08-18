/**
 * RelayRegistry — the control plane's home-machine relay, pure core.
 *
 * Local compute mode: the account's computer is the user's HOME Mac, which
 * keeps one persistent outbound WebSocket here (`/v1/relay/home`). Away
 * devices connect to `/v1/relay/agent` and the relay pipes agent-mux bytes
 * between them, blind to their contents — every frame is opaque; all agent
 * protocol intelligence lives at the two desktop endpoints.
 *
 * Wire, home leg (one socket carries every away client, so frames are
 * enveloped):
 *   text (JSON)  relay → home  {"t":"open","conn":"<id>"} / {"t":"close","conn":"<id>"}
 *                home → relay  {"t":"close","conn":"<id>"}   (force-drop one client)
 *   binary       both ways     connId (8 ascii hex bytes) ‖ one whole mux frame
 *
 * Wire, away leg: each binary message is one whole mux frame, unenveloped.
 *
 * Unknown conn ids and short binaries are DROPPED silently — closes race
 * with in-flight frames as a matter of course, not as protocol errors.
 *
 * LIMITATION (stated, load-bearing): presence and piping are in-memory, so
 * this only works while the control plane runs as a SINGLE instance (true
 * on Railway today). A second replica would strand home and away devices on
 * different processes; scaling out needs a shared broker.
 */

import { randomBytes } from "node:crypto";

export const CLOSE_REPLACED = 4000;
export const CLOSE_HOME_OFFLINE = 4404;
export const CONN_ID_BYTES = 8;

/** The slice of a WebSocket the registry needs — injectable for tests. */
export interface RelaySocket {
  send(data: string | Uint8Array): void;
  close(code: number, reason?: string): void;
}

interface HomeEntry {
  socket: RelaySocket;
  /** connId → away socket, the fan-in this home serves. */
  clients: Map<string, RelaySocket>;
}

export class RelayRegistry {
  private readonly homes = new Map<string, HomeEntry>();
  private readonly connId: () => string;

  constructor(options?: { connId?: () => string }) {
    this.connId = options?.connId ?? (() => randomBytes(CONN_ID_BYTES / 2).toString("hex"));
  }

  homeOnline(userId: string): boolean {
    return this.homes.has(userId);
  }

  /**
   * The user's home Mac attached. Newest wins: the previous home socket is
   * closed `4000`, and every away client is closed `4404` too — their
   * per-conn state (pty subscriptions) lived in the old home process, and a
   * silent re-pipe would leave them talking to a bridge that has never heard
   * of them. They reconnect and the new bridge gets fresh opens.
   */
  attachHome(userId: string, socket: RelaySocket): void {
    const previous = this.homes.get(userId);
    if (previous !== undefined) {
      this.homes.delete(userId);
      for (const client of previous.clients.values()) {
        client.close(CLOSE_HOME_OFFLINE, "home-offline");
      }
      previous.socket.close(CLOSE_REPLACED, "replaced");
    }
    this.homes.set(userId, { socket, clients: new Map() });
  }

  /** The home socket dropped (only honored for the CURRENT one — a stale
   *  close event from a replaced socket must not evict its successor). */
  detachHome(userId: string, socket: RelaySocket): void {
    const home = this.homes.get(userId);
    if (home === undefined || home.socket !== socket) return;
    this.homes.delete(userId);
    for (const client of home.clients.values()) {
      client.close(CLOSE_HOME_OFFLINE, "home-offline");
    }
  }

  /** A frame (or control message) from the home Mac. */
  homeMessage(userId: string, data: string | Uint8Array): void {
    const home = this.homes.get(userId);
    if (home === undefined) return;
    if (typeof data === "string") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        return; // malformed control text — ignored
      }
      const message = parsed as { t?: unknown; conn?: unknown };
      if (message.t === "close" && typeof message.conn === "string") {
        const client = home.clients.get(message.conn);
        if (client !== undefined) {
          home.clients.delete(message.conn);
          client.close(1000, "closed by home");
        }
      }
      return;
    }
    if (data.byteLength < CONN_ID_BYTES) return; // short binary — dropped
    const conn = Buffer.from(data.subarray(0, CONN_ID_BYTES)).toString("ascii");
    const client = home.clients.get(conn);
    if (client === undefined) return; // races a close — dropped
    client.send(data.subarray(CONN_ID_BYTES));
  }

  /**
   * An away device attached. Returns its connId, or null when there is no
   * home online — in which case the socket has already been closed `4404`
   * (one machine-readable signal, distinguishable from network failure).
   */
  attachClient(userId: string, socket: RelaySocket): string | null {
    const home = this.homes.get(userId);
    if (home === undefined) {
      socket.close(CLOSE_HOME_OFFLINE, "home-offline");
      return null;
    }
    const conn = this.connId();
    home.clients.set(conn, socket);
    home.socket.send(JSON.stringify({ t: "open", conn }));
    return conn;
  }

  /** A mux frame from an away device — enveloped and piped home. */
  clientMessage(userId: string, conn: string, data: Uint8Array): void {
    const home = this.homes.get(userId);
    if (home === undefined || !home.clients.has(conn)) return;
    const enveloped = Buffer.concat([Buffer.from(conn, "ascii"), Buffer.from(data)]);
    home.socket.send(enveloped);
  }

  /** An away device dropped; the home bridge tears down that conn's state. */
  detachClient(userId: string, conn: string): void {
    const home = this.homes.get(userId);
    if (home === undefined || !home.clients.delete(conn)) return;
    home.socket.send(JSON.stringify({ t: "close", conn }));
  }
}
