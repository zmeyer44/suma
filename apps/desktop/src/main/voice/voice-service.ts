/**
 * VoiceService — the voice assistant's state machine, in MAIN.
 *
 *   off ──enable──► listening ──"suma"/⌥Space──► connecting ──► active
 *                       ▲                                          │
 *                       └––––––––––– session ends –––––––––––––––––┘
 *
 * While LISTENING, mic frames from the overlay renderer feed only the
 * on-device wake-word engine — nothing leaves this Mac. A detection (or the
 * push-to-talk shortcut) opens a Gemini Live session; from then until the
 * session closes, frames stream to the model and its spoken replies stream
 * back to the renderer. Frames spoken while the session is still
 * connecting are buffered and flushed on ready, so "Suma, what's the
 * weather tomorrow" works as one breath — the words after the wake word
 * arrive at the model even though the socket opened mid-sentence.
 *
 * The browser tools are the chat sidebar's own (enabledBrowserTools), so the
 * Assistant settings page's per-capability toggles govern the voice exactly
 * as they govern the chat — one permission surface, enforced in one place.
 *
 * Settings persist in voice.json (chmod 600 — it may hold the Gemini key),
 * device-local like tts.json. Sessions auto-close after a quiet period; an
 * open Live socket bills by the minute and "Jarvis" must not become a
 * standing meter.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { ChatSettings } from "../../shared/chat";
import {
  mergeVoiceSettings,
  parseVoiceSettings,
  voiceSettingsInfo,
  VOICE_SETTINGS_FILENAME,
  type VoiceKeyState,
  type VoiceSettings,
  type VoiceSettingsInfo,
  type VoiceSettingsPatch,
  type VoiceStatus,
  type WakeWordState,
} from "../../shared/voice";
import {
  enabledBrowserTools,
  type BrowserToolDeps,
} from "../chat/chat-tools";
import { VoiceLiveSession } from "./live-session";
import { adaptToolsForVoice, voiceSystemInstruction } from "./voice-core";
import { WakeWordEngine } from "./wake-word";

/** The env vars a Gemini key is looked for in, in order. */
const GEMINI_ENV_KEYS = ["GEMINI_API_KEY", "GOOGLE_API_KEY"];

/** A session this quiet is over. Generous: a "read the page" reply takes a
 *  while, and tool activity counts as life. */
const IDLE_TIMEOUT_MS = 45_000;
const IDLE_POLL_MS = 5_000;

/** connecting-phase mic buffer cap (~10 s at the renderer's ~100 ms frames)
 *  — a socket that takes longer than this has failed anyway. */
const MAX_PENDING_FRAMES = 100;

export interface VoiceEmitter {
  status: (status: VoiceStatus) => void;
  transcript: (event: { role: "user" | "assistant"; text: string }) => void;
  /** 24 kHz PCM16 reply audio → the overlay renderer's player. */
  audioOut: (data: Uint8Array) => void;
  /** Barge-in: the renderer must drop scheduled playback immediately. */
  interrupted: () => void;
}

export interface VoiceServiceDeps {
  userDataDir: string;
  browser: BrowserToolDeps;
  /** The Assistant page's live tool-group toggles — read per session so a
   *  revoked capability is gone from the very next conversation. */
  chatToolSettings: () => ChatSettings;
  emit: VoiceEmitter;
  env?: NodeJS.ProcessEnv;
}

export class VoiceService {
  private readonly filePath: string;
  private readonly env: NodeJS.ProcessEnv;
  private settingsCache: VoiceSettings;

  private phase: VoiceStatus["phase"] = "off";
  private wakeState: WakeWordState = "off";
  private lastError: string | null = null;

  private engine: WakeWordEngine | null = null;
  private session: VoiceLiveSession | null = null;
  private pendingFrames: Uint8Array[] = [];
  /** Stale-callback guard: every (re)configuration bumps it. */
  private generation = 0;
  private lastActivity = 0;
  private idleTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(private readonly deps: VoiceServiceDeps) {
    this.env = deps.env ?? process.env;
    this.filePath = path.join(deps.userDataDir, VOICE_SETTINGS_FILENAME);
    mkdirSync(deps.userDataDir, { recursive: true });
    this.settingsCache = this.read();
    if (this.settingsCache.enabled) this.startListening();
  }

  /* ------------------------------- settings ------------------------------ */

  private read(): VoiceSettings {
    if (!existsSync(this.filePath)) return parseVoiceSettings("");
    try {
      return parseVoiceSettings(readFileSync(this.filePath, "utf8"));
    } catch {
      return parseVoiceSettings("");
    }
  }

  private persist(): void {
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.settingsCache, null, 2), {
      mode: 0o600,
    });
    renameSync(tmp, this.filePath);
    chmodSync(this.filePath, 0o600);
  }

  settings(): VoiceSettingsInfo {
    return voiceSettingsInfo(this.settingsCache, this.keyState());
  }

  updateSettings(patch: VoiceSettingsPatch): VoiceSettingsInfo {
    const before = this.settingsCache;
    this.settingsCache = mergeVoiceSettings(before, patch);
    this.persist();
    const after = this.settingsCache;

    if (before.enabled && !after.enabled) {
      this.shutDownRuntime();
      this.setStatus("off", "off", null);
    } else if (after.enabled) {
      const wakeChanged =
        before.wakeWord !== after.wakeWord ||
        before.wakeWordEnabled !== after.wakeWordEnabled;
      if (!before.enabled || wakeChanged) this.startListening();
    }
    return this.settings();
  }

  private keyState(): VoiceKeyState {
    for (const name of GEMINI_ENV_KEYS) {
      const value = this.env[name];
      if (typeof value === "string" && value.trim() !== "") return "env";
    }
    return this.settingsCache.apiKey.trim() !== "" ? "stored" : "unset";
  }

  private resolveApiKey(): string | null {
    for (const name of GEMINI_ENV_KEYS) {
      const value = this.env[name];
      if (typeof value === "string" && value.trim() !== "") return value.trim();
    }
    const stored = this.settingsCache.apiKey.trim();
    return stored === "" ? null : stored;
  }

  /* -------------------------------- status ------------------------------- */

  status(): VoiceStatus {
    return { phase: this.phase, wakeWord: this.wakeState, error: this.lastError };
  }

  private setStatus(
    phase: VoiceStatus["phase"],
    wakeWord: WakeWordState,
    error: string | null,
  ): void {
    this.phase = phase;
    this.wakeState = wakeWord;
    this.lastError = error;
    this.deps.emit.status(this.status());
  }

  /* ------------------------------ arming (idle) --------------------------- */

  /**
   * Enter "listening": armed for ⌥Space immediately, and for the wake word
   * once the on-device model is present + loaded (downloaded on first use).
   * Any live session is torn down first — settings changes restart cleanly.
   */
  private startListening(): void {
    this.shutDownRuntime();
    const generation = ++this.generation;
    if (!this.settingsCache.wakeWordEnabled) {
      this.setStatus("listening", "off", null);
      return;
    }

    const engine = new WakeWordEngine({
      modelsDir: path.join(this.deps.userDataDir, "voice-models"),
    });
    this.engine = engine;
    // "downloading" until the spotter is actually ARMED, even when the model
    // files are already on disk — reporting ready off mere file presence
    // opens a window where the HUD says "say Suma" while feed() still drops
    // every frame (arming is async; a phrase spoken during it would vanish).
    this.setStatus("listening", "downloading", null);
    void (async () => {
      try {
        await engine.ensureModel();
        await engine.arm(this.settingsCache.wakeWord);
        if (this.generation !== generation) return;
        // Arming may have raced a session start; only repaint idle states.
        if (this.phase === "listening") {
          this.setStatus("listening", "ready", this.lastError);
        } else {
          this.wakeState = "ready";
        }
      } catch (err) {
        console.error("suma voice: wake word unavailable:", err);
        if (this.generation !== generation) return;
        engine.dispose();
        if (this.engine === engine) this.engine = null;
        if (this.phase === "listening") {
          this.setStatus("listening", "unavailable", this.lastError);
        } else {
          this.wakeState = "unavailable";
        }
      }
    })();
  }

  /* ------------------------------ audio inflow ---------------------------- */

  /** One mic frame from the overlay renderer (16 kHz PCM16). */
  acceptAudio(frame: Uint8Array): void {
    if (this.stopped || frame.byteLength === 0) return;
    switch (this.phase) {
      case "listening": {
        const engine = this.engine;
        if (engine !== null && engine.armed && engine.feed(frame)) {
          // The wake word just completed — everything the user says next
          // belongs to the session. Buffering starts with THIS call's
          // successors; the wake word itself stays out of the conversation.
          this.startSession();
        }
        return;
      }
      case "connecting":
        if (this.pendingFrames.length < MAX_PENDING_FRAMES) {
          this.pendingFrames.push(frame);
        }
        return;
      case "active":
        this.session?.sendAudio(frame);
        this.touch();
        return;
      case "off":
        return;
    }
  }

  /* ------------------------------- sessions ------------------------------- */

  /** The ⌥Space / menu toggle: start a conversation, or end the current one. */
  toggleSession(): void {
    if (this.phase === "active" || this.phase === "connecting") {
      this.stopSession();
    } else if (this.phase === "listening") {
      this.startSession();
    }
    // "off": the feature is disabled; the shortcut stays inert on purpose.
  }

  startSession(): void {
    if (this.stopped || this.phase === "connecting" || this.phase === "active") {
      return;
    }
    if (!this.settingsCache.enabled) return;

    const apiKey = this.resolveApiKey();
    if (apiKey === null) {
      this.setStatus(
        "listening",
        this.wakeState,
        "No Gemini API key — add one under Settings → Voice assistant, or set GEMINI_API_KEY.",
      );
      return;
    }

    const generation = ++this.generation;
    this.pendingFrames = [];
    this.setStatus("connecting", this.wakeState, null);

    const settings = this.settingsCache;
    const tools = adaptToolsForVoice(
      enabledBrowserTools(this.deps.browser, this.deps.chatToolSettings()),
    );
    void VoiceLiveSession.connect({
      apiKey,
      model: settings.model,
      voice: settings.voice,
      systemInstruction: voiceSystemInstruction(settings.wakeWord),
      tools,
      callbacks: {
        onAudio: (data) => {
          if (this.generation !== generation) return;
          this.deps.emit.audioOut(data);
          this.touch();
        },
        onTranscript: (role, text) => {
          if (this.generation !== generation) return;
          this.deps.emit.transcript({ role, text });
          this.touch();
        },
        onInterrupted: () => {
          if (this.generation !== generation) return;
          this.deps.emit.interrupted();
          this.touch();
        },
        onToolActivity: () => this.touch(),
        onClosed: (error) => {
          if (this.generation !== generation) return;
          this.endSession(error);
        },
      },
    }).then(
      (session) => {
        if (this.generation !== generation) {
          session.close(); // superseded while connecting
          return;
        }
        // connect() resolves only after the server's setupComplete, so the
        // session takes audio from its first moment here.
        this.session = session;
        this.setStatus("active", this.wakeState, null);
        // The words spoken while the socket was opening.
        for (const frame of this.pendingFrames) session.sendAudio(frame);
        this.pendingFrames = [];
        this.touch();
        this.startIdleTimer();
      },
      (err: unknown) => {
        if (this.generation !== generation) return;
        this.endSession(
          err instanceof Error ? err.message : "could not start the voice session",
        );
      },
    );
  }

  /** End the conversation and return to armed listening. */
  stopSession(): void {
    if (this.phase !== "active" && this.phase !== "connecting") return;
    this.generation++; // silence the closing session's callbacks
    this.session?.close();
    this.endSession(null);
  }

  private endSession(error: string | null): void {
    this.session?.close();
    this.session = null;
    this.pendingFrames = [];
    this.clearIdleTimer();
    this.deps.emit.interrupted(); // drop any half-played reply
    if (this.stopped || !this.settingsCache.enabled) {
      this.setStatus("off", "off", error);
      return;
    }
    this.setStatus("listening", this.wakeState, error);
  }

  private touch(): void {
    this.lastActivity = Date.now();
  }

  private startIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = setInterval(() => {
      if (this.phase !== "active") return;
      if (Date.now() - this.lastActivity > IDLE_TIMEOUT_MS) {
        this.stopSession();
      }
    }, IDLE_POLL_MS);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== null) clearInterval(this.idleTimer);
    this.idleTimer = null;
  }

  /* ------------------------------- teardown ------------------------------- */

  private shutDownRuntime(): void {
    this.generation++;
    this.session?.close();
    this.session = null;
    this.engine?.dispose();
    this.engine = null;
    this.pendingFrames = [];
    this.clearIdleTimer();
  }

  /** Teardown (sign-out, quit): nothing may outlive the service graph. */
  stop(): void {
    this.stopped = true;
    this.shutDownRuntime();
    this.phase = "off";
    this.wakeState = "off";
  }
}
