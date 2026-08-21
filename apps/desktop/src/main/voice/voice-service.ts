/**
 * VoiceService — the voice assistant's state machine, in MAIN.
 *
 *   off ──enable──► listening ──"suma"/⌥Space──► connecting ──► active
 *                       ▲                                          │
 *                       └––––––––––– session ends –––––––––––––––––┘
 *
 * While LISTENING, mic frames from the chrome renderer feed only the
 * on-device wake-word engine — nothing leaves this Mac. A detection (or the
 * push-to-talk shortcut) starts a VoiceAgentSession: the chat sidebar's AI
 * SDK agent loop with speech at both ends (agent-session.ts). "Connecting"
 * covers credential resolution (the vended path is a network round trip);
 * frames spoken during it are buffered and flushed on ready, so "Suma,
 * what's the weather tomorrow" works as one breath.
 *
 * Model access rides the chat sidebar's exact credential chain — env
 * gateway key, the stored Vercel key, then the signed-in control plane's
 * gateway proxy — and the tools ARE the chat sidebar's own
 * (enabledAssistantTools, browser + memory), so the Assistant settings
 * page's per-capability
 * toggles govern the voice exactly as they govern the chat. The realtime
 * TTS provider's key is the one Settings → Voice & audio stores (Bland
 * today), resolved through TtsService.
 *
 * Settings persist in voice.json, device-local like tts.json — no
 * credentials in it, ever. Sessions auto-close after a quiet period; every
 * turn costs transcription + inference + synthesis, and "Jarvis" must not
 * become a standing meter.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { createGateway } from "ai";
import { isToolGroupEnabled, type ChatSettings } from "../../shared/chat";
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
  type VoiceTtsKeyState,
  type VoiceTtsProviderId,
  type WakeWordState,
} from "../../shared/voice";
import {
  enabledAssistantTools,
  type BrowserToolDeps,
} from "../chat/chat-tools";
import { GATEWAY_ENV_KEYS } from "../chat/chat-service";
import type { MemoryService } from "../memory/memory-service";
import { VoiceAgentSession, type Gateway } from "./agent-session";
import { BlandRealtimeTts } from "./tts-realtime";
import type { RealtimeTtsProvider } from "./tts-realtime-core";
import { voiceSystemInstruction } from "./voice-core";
import { WakeWordEngine } from "./wake-word";

/** A session this quiet is over. Generous: a "read the page" turn takes a
 *  while, and every conversation event counts as life. */
const IDLE_TIMEOUT_MS = 45_000;
const IDLE_POLL_MS = 5_000;

/** connecting-phase mic buffer cap (~10 s at the renderer's ~128 ms frames)
 *  — a credential that takes longer than this has failed anyway. */
const MAX_PENDING_FRAMES = 100;

export interface VoiceEmitter {
  status: (status: VoiceStatus) => void;
  transcript: (event: { role: "user" | "assistant"; text: string }) => void;
  /** 24 kHz PCM16 reply audio → the chrome renderer's player. */
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
  /** Long-term memory — same instance the chat sidebar uses, so both mouths
   *  of the assistant remember the same things. */
  memory?: MemoryService;
  emit: VoiceEmitter;
  /** The stored gateway key (TTS's Vercel key), read per session — the
   *  chat sidebar's exact sharing. */
  storedApiKey: () => string | null;
  /** Vended inference: whether a control plane is configured (sync, for the
   *  settings status line) and the current device credentials for its
   *  gateway proxy (per session — device tokens are short-lived). Both
   *  absent in builds without account support. Mirrors ChatService. */
  vendedGatewayAvailable?: () => boolean;
  vendedGatewayCredentials?: () => Promise<{
    baseUrl: string;
    token: string;
  } | null>;
  /** The realtime TTS provider's key (tts.json's, via TtsService) and its
   *  provenance for the settings page. */
  ttsApiKey: (provider: VoiceTtsProviderId) => string | null;
  ttsKeyState: (provider: VoiceTtsProviderId) => VoiceTtsKeyState;
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
  private session: VoiceAgentSession | null = null;
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
    writeFileSync(tmp, JSON.stringify(this.settingsCache, null, 2));
    renameSync(tmp, this.filePath);
  }

  settings(): VoiceSettingsInfo {
    return voiceSettingsInfo(
      this.settingsCache,
      this.keyState(),
      this.deps.ttsKeyState(this.settingsCache.ttsProvider),
    );
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
    for (const name of GATEWAY_ENV_KEYS) {
      const value = this.env[name];
      if (typeof value === "string" && value.trim() !== "") return "env";
    }
    const stored = this.deps.storedApiKey();
    if (stored !== null && stored.trim() !== "") return "stored";
    // A signed-in account reaches models through the control plane's proxy;
    // an explicit key always wins so users can bring their own.
    return this.deps.vendedGatewayAvailable?.() === true ? "vended" : "unset";
  }

  /**
   * The gateway provider for ONE conversation, bound to whichever credential
   * the chain resolves. Null means the vend was configured but failed
   * (offline, expired device token) — distinct from "unset", which keyState
   * reports before anything starts.
   */
  private async resolveGateway(): Promise<Gateway | null> {
    for (const name of GATEWAY_ENV_KEYS) {
      const value = this.env[name];
      if (typeof value === "string" && value.trim() !== "") {
        console.log(`suma voice: using the ${name} gateway key`);
        return createGateway({ apiKey: value.trim() });
      }
    }
    const stored = this.deps.storedApiKey();
    if (stored !== null && stored.trim() !== "") {
      console.log("suma voice: using the stored gateway key");
      return createGateway({ apiKey: stored.trim() });
    }
    const credentials = await this.deps.vendedGatewayCredentials?.();
    if (!credentials) return null;
    // The control plane's proxy speaks the gateway protocol at this path —
    // the same base ChatService points the SDK at.
    console.log(`suma voice: using the vended gateway via ${credentials.baseUrl}`);
    return createGateway({
      baseURL: `${credentials.baseUrl.replace(/\/+$/, "")}/v1/ai/gateway/v4/ai`,
      apiKey: credentials.token,
    });
  }

  /** The session's realtime speech engine, or a thrown user-readable no. */
  private ttsProvider(settings: VoiceSettings): RealtimeTtsProvider {
    const apiKey = this.deps.ttsApiKey(settings.ttsProvider);
    if (apiKey === null) {
      throw new Error(
        "The voice needs a Bland API key for speech — add one under Settings → Voice & audio.",
      );
    }
    return new BlandRealtimeTts({ apiKey, voice: settings.voice });
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

  /** One mic frame from the chrome renderer (16 kHz PCM16). */
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
        // The session's endpointer decides what is speech; conversation
        // events (not raw frames) feed the idle timer, so a silent room
        // still times out.
        this.session?.acceptAudio(frame);
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

    if (this.keyState() === "unset") {
      this.setStatus(
        "listening",
        this.wakeState,
        "No model access — sign in to your Suma account, add a key under Settings → Assistant, or set AI_GATEWAY_API_KEY.",
      );
      return;
    }

    const generation = ++this.generation;
    this.pendingFrames = [];
    this.setStatus("connecting", this.wakeState, null);

    const settings = this.settingsCache;
    // Resolved per session, exactly like the chat run: a key added (or a
    // capability revoked) in settings applies to the next conversation.
    const chatToolSettings = this.deps.chatToolSettings();
    const memory =
      isToolGroupEnabled(chatToolSettings, "memory") &&
      this.deps.memory !== undefined
        ? this.deps.memory
        : null;
    const tools = enabledAssistantTools(
      this.deps.browser,
      chatToolSettings,
      memory,
    );
    void Promise.all([
      this.resolveGateway(),
      // Best-effort, like the chat run: a session never fails for lack of
      // memory, it just runs memoryless.
      memory?.wakeContext().catch(() => null) ?? Promise.resolve(null),
    ])
      .then(([gateway, memoryContext]) => {
        if (this.generation !== generation) return;
        if (gateway === null) {
          throw new Error(
            "Signed in, but the control plane is unreachable right now — try again, or add your own AI Gateway key in Settings.",
          );
        }
        console.log(
          `suma voice: session starting — model ${settings.model}, stt ${settings.sttModel}, tts ${settings.ttsProvider}/${settings.voice}, tools [${Object.keys(tools).join(", ")}]`,
        );
        const session = new VoiceAgentSession({
          gateway,
          model: settings.model,
          sttModel: settings.sttModel,
          narratorModel: settings.narratorModel,
          tools,
          systemInstruction:
            memoryContext === null
              ? voiceSystemInstruction(settings.wakeWord)
              : `${voiceSystemInstruction(settings.wakeWord)}\n\n${memoryContext}`,
          tts: this.ttsProvider(settings),
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
            onActivity: () => this.touch(),
            onClosed: (error) => {
              if (this.generation !== generation) return;
              this.endSession(error);
            },
          },
        });
        this.session = session;
        this.setStatus("active", this.wakeState, null);
        // The words spoken while credentials resolved.
        for (const frame of this.pendingFrames) session.acceptAudio(frame);
        this.pendingFrames = [];
        this.touch();
        this.startIdleTimer();
      })
      .catch((err: unknown) => {
        if (this.generation !== generation) return;
        this.endSession(
          err instanceof Error ? err.message : "could not start the voice session",
        );
      });
  }

  /** End the conversation and return to armed listening. */
  stopSession(): void {
    if (this.phase !== "active" && this.phase !== "connecting") return;
    this.generation++; // silence the closing session's callbacks
    this.session?.close();
    this.endSession(null);
  }

  private endSession(error: string | null): void {
    if (error !== null) {
      // The HUD truncates; the terminal keeps the whole line.
      console.error("suma voice: session ended with error:", error);
    }
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
