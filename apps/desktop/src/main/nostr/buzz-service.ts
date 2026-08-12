/**
 * BuzzService — fetches the agent roster from the user's Buzz relay
 * (github.com/block/buzz). One shot per refresh: connect, answer the
 * NIP-42 AUTH challenge with the stored nostr key (the user's key IS their
 * buzz owner identity — that is the premise of the integration), page
 * through two historical REQs (roster, then avatars), fold, disconnect.
 *
 * No live subscription on purpose: the roster renders on a settings page,
 * so a snapshot on demand is the honest lifetime — nothing here should
 * hold a socket open to a workspace the user closed the page on.
 *
 * The relay is UNTRUSTED input end to end: frames go through
 * parseRelayMessage's sanitizers, and the fold accepts only well-formed
 * events (buzz-core.ts).
 */

import {
  IDLE_BUZZ_STATE,
  type BuzzAgentsState,
  type NostrSignedEvent,
} from "../../shared/nostr";
import {
  authReply,
  buildAgentList,
  closeRequest,
  detailRequest,
  DETAIL_SUB_ID,
  firstTagValue,
  parseRelayMessage,
  relayMediaSha256,
  rosterRequest,
  ROSTER_SUB_ID,
  BUZZ_KIND_MANAGED_AGENT,
  type RelayEvent,
} from "./buzz-core";

/** A relay that has not finished answering in this long is not going to. */
const FETCH_TIMEOUT_MS = 12_000;
/** An avatar bigger than this is not an avatar. */
const MAX_AVATAR_BYTES = 1_000_000;

/** The narrow WebSocket surface the fetcher uses — injectable for tests. */
export interface BuzzSocket {
  send(data: string): void;
  close(): void;
  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: { data?: unknown }) => void): void;
}

export interface BuzzServiceDeps {
  /** The configured relay, read per refresh (NostrService owns it). */
  relayUrl: () => string | null;
  /** Sign the NIP-42 kind:22242 AUTH event; null ⇒ no key configured. */
  signAuth: (relayUrl: string, challenge: string) => NostrSignedEvent | null;
  /** Sign a Blossom GET (kind:24242) for a relay-hosted avatar blob. */
  signMediaAuth: (sha256: string, serverHost: string) => NostrSignedEvent | null;
  emitChanged: (state: BuzzAgentsState) => void;
  now?: () => number;
  /** Injected by tests; production uses the Node globals. */
  connect?: (url: string) => BuzzSocket;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class BuzzService {
  private readonly deps: BuzzServiceDeps;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private current: BuzzAgentsState = { ...IDLE_BUZZ_STATE };
  private inFlight: Promise<BuzzAgentsState> | null = null;
  private stopped = false;

  constructor(deps: BuzzServiceDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
    this.timeoutMs = deps.timeoutMs ?? FETCH_TIMEOUT_MS;
  }

  state(): BuzzAgentsState {
    return { ...this.current, agents: [...this.current.agents] };
  }

  /** Sign-out / quit: never resolve a fetch into a dead graph. */
  stop(): void {
    this.stopped = true;
  }

  /** Fetch now; concurrent callers share one flight. */
  refresh(): Promise<BuzzAgentsState> {
    if (this.inFlight !== null) return this.inFlight;
    const flight = this.fetchOnce().finally(() => {
      this.inFlight = null;
    });
    this.inFlight = flight;
    return flight;
  }

  private setState(state: BuzzAgentsState): BuzzAgentsState {
    this.current = state;
    if (!this.stopped) this.deps.emitChanged(this.state());
    return this.state();
  }

  private async fetchOnce(): Promise<BuzzAgentsState> {
    const relayUrl = this.deps.relayUrl();
    if (relayUrl === null) {
      return this.setState({ ...IDLE_BUZZ_STATE });
    }
    this.setState({
      status: "loading",
      relayUrl,
      // The previous roster stays up while refreshing — a flash of empty
      // grid on every refresh would read as agents disappearing.
      agents: this.current.relayUrl === relayUrl ? this.current.agents : [],
      error: null,
      fetchedAtMs: this.current.fetchedAtMs,
    });
    try {
      const agents = await this.collect(relayUrl);
      await this.resolveRelayAvatars(relayUrl, agents);
      return this.setState({
        status: "ready",
        relayUrl,
        agents,
        error: null,
        fetchedAtMs: this.now(),
      });
    } catch (err) {
      const message =
        err instanceof Error && err.message !== ""
          ? err.message
          : "Could not reach the relay.";
      return this.setState({
        status: "error",
        relayUrl,
        agents: [],
        error: message,
        fetchedAtMs: this.current.fetchedAtMs,
      });
    }
  }

  /**
   * Relay-hosted avatars sit behind Blossom-authenticated GETs (a bare
   * <img> gets a 401), so main fetches those bytes with a signed kind:24242
   * header and hands the renderer a data: URI instead. Foreign-host
   * avatars pass through untouched; any failure downgrades that one agent
   * to the glyph rather than failing the roster.
   */
  private async resolveRelayAvatars(
    relayUrl: string,
    agents: Array<{ avatarUrl: string | null }>,
  ): Promise<void> {
    const fetchImpl = this.deps.fetchImpl ?? fetch;
    const host = new URL(relayUrl).host;
    await Promise.all(
      agents.map(async (agent) => {
        if (agent.avatarUrl === null) return;
        const sha256 = relayMediaSha256(agent.avatarUrl, relayUrl);
        if (sha256 === null) return;
        const auth = this.deps.signMediaAuth(sha256, host);
        if (auth === null) {
          agent.avatarUrl = null;
          return;
        }
        try {
          const response = await fetchImpl(agent.avatarUrl, {
            headers: {
              authorization: `Nostr ${Buffer.from(JSON.stringify(auth)).toString("base64")}`,
            },
          });
          if (!response.ok) throw new Error(String(response.status));
          const bytes = Buffer.from(await response.arrayBuffer());
          if (bytes.byteLength === 0 || bytes.byteLength > MAX_AVATAR_BYTES) {
            throw new Error("bad size");
          }
          const mime = response.headers.get("content-type")?.split(";")[0] ?? "image/png";
          agent.avatarUrl = `data:${mime};base64,${bytes.toString("base64")}`;
        } catch {
          agent.avatarUrl = null;
        }
      }),
    );
  }

  /** The wire conversation. Resolves with the folded agent list. */
  private collect(relayUrl: string): Promise<ReturnType<typeof buildAgentList>> {
    const connect =
      this.deps.connect ?? ((url: string) => new WebSocket(url) as unknown as BuzzSocket);
    return new Promise((resolve, reject) => {
      let socket: BuzzSocket;
      try {
        socket = connect(relayUrl);
      } catch {
        reject(new Error("Not a reachable websocket URL."));
        return;
      }
      const events: RelayEvent[] = [];
      let phase: "roster" | "detail" = "roster";
      let authed = false;
      // One post-auth retry: an eager REQ sent before our AUTH landed gets
      // its auth-required CLOSED back AFTER we authenticated (frames answer
      // in server order, and the sub id cannot say which REQ was refused).
      let authRetries = 1;
      let settled = false;

      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          socket.close();
        } catch {
          // Already closed — the point was to stop, and it is stopped.
        }
        fn();
      };
      const timer = setTimeout(() => {
        finish(() => reject(new Error("The relay did not answer in time.")));
      }, this.timeoutMs);

      const sendPhase = (): void => {
        if (phase === "roster") {
          socket.send(JSON.stringify(rosterRequest()));
        } else {
          const pubkeys = agentPubkeys(events);
          socket.send(JSON.stringify(detailRequest(pubkeys)));
        }
      };

      socket.addEventListener("open", () => sendPhase());
      socket.addEventListener("error", () => {
        finish(() => reject(new Error("Could not connect to the relay.")));
      });
      socket.addEventListener("close", () => {
        finish(() => reject(new Error("The relay closed the connection.")));
      });
      socket.addEventListener("message", (frame) => {
        const message = parseRelayMessage(frame.data);
        switch (message.type) {
          case "auth": {
            // Buzz relays mandate NIP-42; answer with the stored key. No
            // key ⇒ the roster is unreadable, say so rather than hanging.
            const signed = this.deps.signAuth(relayUrl, message.challenge);
            if (signed === null) {
              finish(() =>
                reject(
                  new Error(
                    "This relay requires authentication — set up your Nostr key first.",
                  ),
                ),
              );
              return;
            }
            authed = true;
            socket.send(JSON.stringify(authReply(signed)));
            // Re-issue the current REQ: same sub id replaces the old
            // subscription, so a pre-AUTH refusal is simply retried.
            sendPhase();
            break;
          }
          case "event": {
            if (
              message.subId === ROSTER_SUB_ID ||
              message.subId === DETAIL_SUB_ID
            ) {
              events.push(message.event);
            }
            break;
          }
          case "eose": {
            if (message.subId === ROSTER_SUB_ID && phase === "roster") {
              socket.send(JSON.stringify(closeRequest(ROSTER_SUB_ID)));
              phase = "detail";
              sendPhase();
            } else if (message.subId === DETAIL_SUB_ID && phase === "detail") {
              finish(() => resolve(buildAgentList(events)));
            }
            break;
          }
          case "closed": {
            // Only the CURRENT phase's subscription can refuse the fetch. A
            // CLOSED for anything else is lifecycle noise, not an error:
            // the buzz relay acks a client CLOSE with a bare CLOSED, and
            // the post-auth retry's duplicate roster sub gets one too —
            // both arrive after the phase has already moved on.
            const relevant =
              (phase === "roster" && message.subId === ROSTER_SUB_ID) ||
              (phase === "detail" && message.subId === DETAIL_SUB_ID);
            if (!relevant) break;
            if (message.reason.startsWith("auth-required")) {
              // Before our AUTH: the challenge is coming; answering it
              // re-issues the REQ. After our AUTH: this refusal belongs to
              // the pre-auth REQ that raced it — retry the phase once. A
              // relay that refuses an authenticated member says
              // "restricted:", not "auth-required", so this cannot loop.
              if (!authed) break;
              if (authRetries > 0) {
                authRetries -= 1;
                sendPhase();
                break;
              }
            }
            finish(() =>
              reject(
                new Error(
                  message.reason === ""
                    ? "The relay refused the query."
                    : `The relay refused the query — ${message.reason}`,
                ),
              ),
            );
            break;
          }
          default:
            break;
        }
      });
    });
  }
}

function agentPubkeys(events: RelayEvent[]): string[] {
  const pubkeys = new Set<string>();
  for (const event of events) {
    if (event.kind !== BUZZ_KIND_MANAGED_AGENT) continue;
    const pubkey = firstTagValue(event, "d");
    if (pubkey !== null && /^[0-9a-f]{64}$/.test(pubkey.toLowerCase())) {
      pubkeys.add(pubkey.toLowerCase());
    }
  }
  return [...pubkeys];
}
