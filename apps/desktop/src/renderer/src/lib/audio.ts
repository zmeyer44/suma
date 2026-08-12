/**
 * The application-level audio player. One per app, and it does not stop.
 *
 * WHY IT SURVIVES EVERYTHING. Playback lives in TWO places that outlive the UI:
 *
 *   1. The HTMLAudioElement is created with `new Audio()` and held in a
 *      module-level binding. It is NEVER rendered into the React tree, so no
 *      reconciliation, no remount, and no conditional render can pause it. The
 *      floating player (components/AudioPlayer.tsx, rendered in the overlay
 *      WINDOW and bridged here over IPC — see attachAudioOverlayBridge below)
 *      is a VIEW of this module — hiding or unmounting it is a display change,
 *      not a playback change.
 *   2. That module is loaded by the CHROME renderer, which is the one document
 *      that stays put. Tabs are WebContentsViews layered above this page and
 *      `suma://settings` is drawn by this page, so switching tabs, navigating,
 *      splitting the view, opening settings, or closing the tab the text came
 *      from all leave the audio element untouched. (The chrome page reloads on
 *      exactly one path — sign-out, which resets the whole app; audio stopping
 *      there is correct.)
 *
 * Synthesis is main's job (main/audio/tts-service.ts): this module sends text
 * over `tts:speak` and receives bytes, so no API key is ever in the renderer.
 * Every provider returns a real audio file, which is why there is one engine
 * here rather than a "remote" and a "speechSynthesis" one with different
 * capabilities — position, duration, scrubbing, and rate work the same for the
 * local macOS voice and for OpenAI.
 *
 * A resolved clip's blob URL is CACHED on its queue entry. Replaying a track
 * must not re-synthesize it: that is a second network round trip and, on a paid
 * provider, a second charge for audio we already have.
 */

import { create } from "zustand";
import type { AudioOverlayState } from "../../../shared/ipc";
import {
  clampSpeed,
  clampVolume,
  speechTitle,
  TTS_SPEED_DEFAULT,
  type TtsProviderId,
} from "../../../shared/tts";

/**
 * How the player tells the user something. Injected rather than imported: this
 * module must not depend on the component tree it outlives (and keeping it free
 * of .tsx imports is what lets the node-environment tests load it). main.tsx
 * points it at the chrome's toast stack.
 */
export type AudioNotifier = (
  message: string,
  type: "error" | "info",
) => void;

let notify: AudioNotifier = () => {
  /* Not wired yet: the state still carries the error for the dock to show. */
};

export function setAudioNotifier(notifier: AudioNotifier): void {
  notify = notifier;
}

/**
 * Unwrap Electron's IPC error envelope. A handler that throws arrives here as
 * `Error invoking remote method 'tts:speak': Error: <message>`, and the part
 * worth showing is the message main wrote — "OpenAI: Incorrect API key
 * provided" tells the user what to fix; the envelope tells them about our IPC.
 */
export function unwrapIpcError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const match = /^Error invoking remote method '[^']*':\s*(?:\w*Error:\s*)?(.*)$/s.exec(
    raw,
  );
  const message = (match?.[1] ?? raw).trim();
  return message === "" ? "Speech generation failed." : message;
}

/** TTS text, or an audio file the app already has (a sound, a fetched clip). */
export type AudioSource =
  | {
      kind: "tts";
      text: string;
      /** One-off overrides; otherwise the configured provider/voice is used. */
      provider?: TtsProviderId;
      voice?: string;
    }
  | { kind: "clip"; url: string };

export interface AudioTrackInput {
  /**
   * Stable id, so a caller can ask "is MY thing playing?" — the chat's read
   * -aloud button uses the message id, which is also what makes pressing it
   * twice a pause rather than a second synthesis.
   */
  id: string;
  /** Falls back to the first line of the text. */
  title?: string;
  /** The line under the title: "Assistant", "Voice preview". */
  origin?: string;
  source: AudioSource;
}

export interface AudioTrack {
  id: string;
  title: string;
  origin: string | null;
  source: AudioSource;
  /** Resolved media URL; null until the clip has been synthesized/loaded. */
  url: string | null;
  /** True when `url` is an object URL this module created and must revoke. */
  ownsUrl: boolean;
  /** "OpenAI · Nova", once main has said which voice spoke it. */
  voiceLabel: string | null;
}

export type PlaybackStatus =
  | "idle"
  /** Synthesizing, or waiting for the element to have enough to play. */
  | "preparing"
  | "playing"
  | "paused"
  | "error";

interface AudioState {
  queue: AudioTrack[];
  /** Index into `queue`, or -1 when nothing is loaded. */
  index: number;
  status: PlaybackStatus;
  /** Seconds. */
  position: number;
  /** Seconds; 0 until the element knows. */
  duration: number;
  /** The current track played to its end — the next toggle restarts it. */
  ended: boolean;
  rate: number;
  volume: number;
  muted: boolean;
  error: string | null;

  /** Replace the queue with these tracks and start at `startAt`. */
  play: (tracks: AudioTrackInput | AudioTrackInput[], startAt?: number) => void;
  /** Append without disturbing what is playing; starts if nothing is. */
  enqueue: (tracks: AudioTrackInput | AudioTrackInput[]) => void;
  /**
   * The read-aloud affordance in one call: the same id toggles, a new id
   * replaces. Returns nothing — the dock reflects what happened.
   */
  toggleTrack: (track: AudioTrackInput) => void;
  toggle: () => void;
  pause: () => void;
  resume: () => void;
  /** Stop, clear the queue, and release every blob URL. */
  stop: () => void;
  next: () => void;
  previous: () => void;
  playAt: (index: number) => void;
  seek: (seconds: number) => void;
  skip: (deltaSeconds: number) => void;
  setRate: (rate: number) => void;
  setVolume: (volume: number) => void;
  setMuted: (muted: boolean) => void;
}

/* --------------------------- device-local prefs -------------------------- */

/** Presentation, like the theme and the split ratios — localStorage, not sync. */
const RATE_KEY = "suma.audio.rate";
const VOLUME_KEY = "suma.audio.volume";
const MUTED_KEY = "suma.audio.muted";

function readNumber(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const value = Number(raw);
    return Number.isFinite(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function writeString(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Quota or private mode: the setting just does not survive a reload.
  }
}

/* ------------------------------ the element ------------------------------ */

/**
 * Module-level, deliberately. See the header: an element in the React tree is
 * an element React can unmount, and "do not interrupt playback" is the whole
 * requirement. Created lazily so importing this module costs nothing.
 */
let element: HTMLAudioElement | null = null;

/**
 * Bumped every time the loaded track changes. Every async step (synthesis,
 * `play()`) captures it and does nothing if it no longer matches — otherwise a
 * slow synthesis for a track the user already skipped past would come back and
 * seize the element.
 */
let generation = 0;

/** The in-flight `tts:speak` correlation id, so it can be cancelled. */
let pendingRequestId: string | null = null;

let requestCounter = 0;

function audio(): HTMLAudioElement {
  if (element !== null) return element;
  const el = new Audio();
  el.preload = "auto";
  el.addEventListener("timeupdate", () => {
    useAudioStore.setState({ position: el.currentTime });
  });
  el.addEventListener("durationchange", () => {
    useAudioStore.setState({
      duration: Number.isFinite(el.duration) ? el.duration : 0,
    });
  });
  el.addEventListener("ended", () => {
    const { index, queue } = useAudioStore.getState();
    if (index >= 0 && index + 1 < queue.length) {
      void startIndex(index + 1);
      return;
    }
    // Queue exhausted: hold the last track loaded rather than clearing it, so
    // the dock stays put and the next toggle replays instead of vanishing.
    useAudioStore.setState({
      status: "paused",
      ended: true,
      position: Number.isFinite(el.duration) ? el.duration : el.currentTime,
    });
    updateMediaSession();
  });
  el.addEventListener("error", () => {
    // A decode/load failure — distinct from a synthesis failure, which is
    // reported by the IPC call and never reaches the element.
    fail("This clip could not be played.");
  });
  element = el;
  return el;
}

function fail(message: string): void {
  useAudioStore.setState({ status: "error", error: message });
  notify(message, "error");
  updateMediaSession();
}

/* --------------------------- source resolution -------------------------- */

function toTrack(input: AudioTrackInput): AudioTrack {
  const fallbackTitle =
    input.source.kind === "tts" ? speechTitle(input.source.text) : "Audio";
  return {
    id: input.id,
    title: input.title ?? (fallbackTitle === "" ? "Audio" : fallbackTitle),
    origin: input.origin ?? null,
    source: input.source,
    url: null,
    ownsUrl: false,
    voiceLabel: null,
  };
}

function releaseTrack(track: AudioTrack): void {
  if (track.ownsUrl && track.url !== null) URL.revokeObjectURL(track.url);
}

function releaseAll(tracks: readonly AudioTrack[]): void {
  for (const track of tracks) releaseTrack(track);
}

/**
 * Store the resolved URL on the queue entry so a replay costs nothing. Returns
 * false when the track is no longer queued — a synthesis that landed after the
 * queue moved on, whose blob the caller must therefore revoke itself.
 */
function cacheResolved(
  id: string,
  patch: Pick<AudioTrack, "url" | "ownsUrl" | "voiceLabel">,
): boolean {
  const present = useAudioStore.getState().queue.some((t) => t.id === id);
  if (!present) return false;
  useAudioStore.setState((s) => ({
    queue: s.queue.map((t) => (t.id === id ? { ...t, ...patch } : t)),
  }));
  return true;
}

/**
 * Turn a track's source into something the element can load. Synthesis happens
 * in main; the bytes come back over IPC and become a blob URL here (which is
 * why the chrome page's CSP allows `media-src blob:`).
 */
async function resolveUrl(track: AudioTrack): Promise<string | null> {
  if (track.url !== null) return track.url;
  if (track.source.kind === "clip") {
    cacheResolved(track.id, {
      url: track.source.url,
      ownsUrl: false,
      voiceLabel: null,
    });
    return track.source.url;
  }
  if (!window.suma) {
    fail("Speech is unavailable — the app bridge is not ready.");
    return null;
  }
  requestCounter += 1;
  const requestId = `tts-${String(requestCounter)}`;
  pendingRequestId = requestId;
  const speak: {
    requestId: string;
    text: string;
    provider?: TtsProviderId;
    voice?: string;
  } = { requestId, text: track.source.text };
  if (track.source.provider !== undefined) speak.provider = track.source.provider;
  if (track.source.voice !== undefined) speak.voice = track.source.voice;
  try {
    const clip = await window.suma.invoke("tts:speak", speak);
    const url = URL.createObjectURL(
      new Blob([clip.data as BlobPart], { type: clip.mimeType }),
    );
    const kept = cacheResolved(track.id, {
      url,
      ownsUrl: true,
      voiceLabel: clip.voiceLabel,
    });
    if (!kept) {
      // The queue moved on while the provider was working. Nothing will ever
      // revoke this blob but us.
      URL.revokeObjectURL(url);
      return null;
    }
    if (clip.truncated) {
      notify("That text was long — reading the first part of it.", "info");
    }
    return url;
  } catch (err) {
    // A cancelled synthesis is not a failure: startIndex already moved on.
    if (pendingRequestId !== requestId) return null;
    fail(unwrapIpcError(err));
    return null;
  } finally {
    if (pendingRequestId === requestId) pendingRequestId = null;
  }
}

/** Abandon any synthesis still running for a track we are leaving. */
function cancelPending(): void {
  const requestId = pendingRequestId;
  pendingRequestId = null;
  if (requestId === null || !window.suma) return;
  void window.suma.invoke("tts:cancel", { requestId }).catch(() => undefined);
}

/* ----------------------------- the transport ---------------------------- */

async function startIndex(index: number): Promise<void> {
  const state = useAudioStore.getState();
  const track = state.queue[index];
  if (track === undefined) return;

  cancelPending();
  generation += 1;
  const gen = generation;
  const el = audio();
  el.pause();
  useAudioStore.setState({
    index,
    status: "preparing",
    position: 0,
    duration: 0,
    ended: false,
    error: null,
  });
  updateMediaSession();

  const url = await resolveUrl(track);
  // Skipped, stopped, or replaced while the provider was working.
  if (gen !== generation) return;
  if (url === null) return;

  el.src = url;
  el.playbackRate = useAudioStore.getState().rate;
  applyVolume(el);
  try {
    await el.play();
    if (gen !== generation) return;
    useAudioStore.setState({ status: "playing" });
    updateMediaSession();
  } catch (err) {
    if (gen !== generation) return;
    fail(err instanceof Error ? err.message : "Playback failed to start.");
  }
}

function applyVolume(el: HTMLAudioElement): void {
  const { volume, muted } = useAudioStore.getState();
  el.volume = muted ? 0 : volume;
}

/* ---------------------------- OS media keys ----------------------------- */

/**
 * The Mac's media keys and Now Playing tile. Worth wiring precisely because
 * this player is meant to keep going while the user does something else: if
 * playback outlives the screen it started on, pausing it should not require
 * finding that screen again.
 */
function updateMediaSession(): void {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
  const session = navigator.mediaSession;
  const { queue, index, status } = useAudioStore.getState();
  const track = index >= 0 ? queue[index] : undefined;
  if (track === undefined) {
    session.metadata = null;
    session.playbackState = "none";
    return;
  }
  session.metadata = new MediaMetadata({
    title: track.title,
    artist: track.origin ?? "Suma",
    album: track.voiceLabel ?? "Suma",
  });
  session.playbackState =
    status === "playing" ? "playing" : status === "idle" ? "none" : "paused";
}

function attachMediaSessionHandlers(): void {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
  const session = navigator.mediaSession;
  const store = useAudioStore.getState();
  session.setActionHandler("play", () => store.resume());
  session.setActionHandler("pause", () => store.pause());
  session.setActionHandler("stop", () => store.stop());
  session.setActionHandler("nexttrack", () => store.next());
  session.setActionHandler("previoustrack", () => store.previous());
  session.setActionHandler("seekbackward", () => store.skip(-10));
  session.setActionHandler("seekforward", () => store.skip(10));
  session.setActionHandler("seekto", (event) => {
    if (event.seekTime != null) store.seek(event.seekTime);
  });
}

/* ------------------------------- the store ------------------------------ */

export const useAudioStore = create<AudioState>()((set, get) => ({
  queue: [],
  index: -1,
  status: "idle",
  position: 0,
  duration: 0,
  ended: false,
  rate: clampSpeed(readNumber(RATE_KEY, TTS_SPEED_DEFAULT)),
  volume: clampVolume(readNumber(VOLUME_KEY, 1)),
  muted: readNumber(MUTED_KEY, 0) === 1,
  error: null,

  play: (tracks, startAt = 0) => {
    const inputs = Array.isArray(tracks) ? tracks : [tracks];
    if (inputs.length === 0) return;
    cancelPending();
    releaseAll(get().queue);
    set({ queue: inputs.map(toTrack), index: -1, error: null });
    void startIndex(Math.min(Math.max(startAt, 0), inputs.length - 1));
  },

  enqueue: (tracks) => {
    const inputs = Array.isArray(tracks) ? tracks : [tracks];
    if (inputs.length === 0) return;
    const wasEmpty = get().queue.length === 0;
    set((s) => ({ queue: [...s.queue, ...inputs.map(toTrack)] }));
    if (wasEmpty) void startIndex(0);
  },

  toggleTrack: (input) => {
    const { queue, index, status } = get();
    const current = index >= 0 ? queue[index] : undefined;
    if (current?.id === input.id && status !== "error") {
      get().toggle();
      return;
    }
    get().play(input);
  },

  toggle: () => {
    const { status, ended, index } = get();
    if (status === "idle" || status === "preparing") return;
    if (status === "error") {
      if (index >= 0) void startIndex(index);
      return;
    }
    if (ended) {
      const el = audio();
      el.currentTime = 0;
      set({ ended: false, position: 0 });
      void el
        .play()
        .then(() => {
          set({ status: "playing" });
          updateMediaSession();
        })
        .catch(() => fail("Playback could not restart."));
      return;
    }
    if (status === "playing") get().pause();
    else get().resume();
  },

  pause: () => {
    if (get().status !== "playing") return;
    audio().pause();
    set({ status: "paused" });
    updateMediaSession();
  },

  resume: () => {
    const { status, index } = get();
    if (status === "playing" || index < 0) return;
    if (status === "error") {
      void startIndex(index);
      return;
    }
    void audio()
      .play()
      .then(() => {
        set({ status: "playing" });
        updateMediaSession();
      })
      .catch(() => fail("Playback could not resume."));
  },

  stop: () => {
    cancelPending();
    generation += 1;
    const el = audio();
    el.pause();
    el.removeAttribute("src");
    el.load();
    releaseAll(get().queue);
    set({
      queue: [],
      index: -1,
      status: "idle",
      position: 0,
      duration: 0,
      ended: false,
      error: null,
    });
    updateMediaSession();
  },

  next: () => {
    const { index, queue } = get();
    if (index < 0 || index + 1 >= queue.length) return;
    void startIndex(index + 1);
  },

  previous: () => {
    const { index, position } = get();
    if (index < 0) return;
    // Three seconds in, "previous" means "restart this one" — the same
    // convention every music player uses, and the one that makes the button
    // useful on a single-track queue.
    if (position > 3 || index === 0) {
      get().seek(0);
      return;
    }
    void startIndex(index - 1);
  },

  playAt: (index) => {
    if (index < 0 || index >= get().queue.length) return;
    void startIndex(index);
  },

  seek: (seconds) => {
    const el = audio();
    const { duration, index } = get();
    if (index < 0) return;
    const limit = Number.isFinite(el.duration) ? el.duration : duration;
    const target = Math.min(Math.max(seconds, 0), limit > 0 ? limit : seconds);
    el.currentTime = target;
    set({ position: target, ended: false });
  },

  skip: (delta) => {
    if (get().index < 0) return;
    get().seek(audio().currentTime + delta);
  },

  setRate: (rate) => {
    const next = clampSpeed(rate);
    set({ rate: next });
    writeString(RATE_KEY, String(next));
    // Only touch the element when it holds something: setting playbackRate on
    // an empty element is harmless but pointless.
    if (get().index >= 0) audio().playbackRate = next;
  },

  setVolume: (volume) => {
    const next = clampVolume(volume);
    set({ volume: next, muted: next === 0 ? get().muted : false });
    writeString(VOLUME_KEY, String(next));
    if (element !== null) applyVolume(element);
  },

  setMuted: (muted) => {
    set({ muted });
    writeString(MUTED_KEY, muted ? "1" : "0");
    if (element !== null) applyVolume(element);
  },
}));

attachMediaSessionHandlers();

/* ------------------------- the floating player bridge ------------------- */

/**
 * The player's UI lives in the transparent overlay WINDOW (OverlayStack /
 * AudioPlayer.tsx), because the chrome renders below the tab views — a
 * control drawn here is invisible the moment a page is open. This bridge is
 * the other half of that split: every store change is snapshotted over
 * `audio:publishState` (main relays it to the overlay), and the overlay's
 * taps come back as `audio:control` commands applied to this store.
 *
 * Called once from main.tsx, chrome branch only. `openVoiceSettings` is
 * injected for the same reason the notifier is: this module must not import
 * the component tree or the app store it outlives.
 */
export function attachAudioOverlayBridge(openVoiceSettings: () => void): void {
  if (!window.suma) return;
  const suma = window.suma;

  let lastPublished = "";
  const publish = (): void => {
    const s = useAudioStore.getState();
    const track = selectCurrentTrack(s);
    const snapshot: AudioOverlayState = {
      status: s.status,
      track:
        track === null
          ? null
          : {
              title: track.title,
              origin: track.origin,
              voiceLabel: track.voiceLabel,
            },
      position: s.position,
      duration: s.duration,
      index: s.index,
      queueLength: s.queue.length,
      rate: s.rate,
      muted: s.muted,
      ended: s.ended,
      error: s.error,
    };
    // The store also changes in ways the player cannot see (volume, queue
    // URLs resolving); comparing the snapshot keeps those off the wire.
    const encoded = JSON.stringify(snapshot);
    if (encoded === lastPublished) return;
    lastPublished = encoded;
    void suma.invoke("audio:publishState", snapshot).catch(() => undefined);
  };
  useAudioStore.subscribe(publish);
  publish();

  suma.on("audio:control", (cmd) => {
    const store = useAudioStore.getState();
    switch (cmd.command) {
      case "toggle":
        store.toggle();
        break;
      case "next":
        store.next();
        break;
      case "previous":
        store.previous();
        break;
      case "stop":
        store.stop();
        break;
      case "seek":
        store.seek(cmd.value);
        break;
      case "setRate":
        store.setRate(cmd.value);
        break;
      case "setMuted":
        store.setMuted(cmd.value);
        break;
      case "openVoiceSettings":
        openVoiceSettings();
        break;
    }
  });
}

/* ------------------------------- selectors ------------------------------ */

export function selectCurrentTrack(state: AudioState): AudioTrack | null {
  return state.index >= 0 ? (state.queue[state.index] ?? null) : null;
}

/** Whether THIS id is the loaded track, for a caller's own play/pause button. */
export function selectIsCurrent(state: AudioState, id: string): boolean {
  return selectCurrentTrack(state)?.id === id;
}

/**
 * Read text aloud with the configured voice. The one-line entry point for
 * anything in the chrome that has words worth hearing.
 */
export function speakText(input: AudioTrackInput): void {
  useAudioStore.getState().toggleTrack(input);
}

