/**
 * TtsService — the only place text becomes audio.
 *
 * Main synthesizes, not the renderer, for three reasons that all point the same
 * way: the API key stays in this process (the renderer is handed audio bytes
 * and never a credential), the chrome renderer's CSP does not have to be opened
 * up to two third-party API origins, and the local provider is `say(1)`, which
 * only a process with a shell can reach.
 *
 * `say` rather than the renderer's `speechSynthesis` for the offline provider,
 * deliberately: speechSynthesis is a fire-and-forget utterance queue with no
 * duration, no seeking, an estimated position, and a Chromium bug that suspends
 * long utterances — so a player built on it needs a whole second engine with
 * different capabilities. Rendering `say` to a WAV file instead means every
 * provider returns the same thing (bytes), and the dock has one set of
 * behaviours: real duration, real scrubbing, real playback rate.
 *
 * Settings live in `tts.json` next to workspace.json, chmod 600 because they
 * may hold an API key, and device-local because a key belongs to this Mac (it
 * is added to LOCAL_STATE_FILES so sign-out erases it with everything else).
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DEFAULT_TTS_SETTINGS,
  resolvedModel,
  staticVoices,
  stripForSpeech,
  ttsProviderInfo,
  type TtsClip,
  type TtsKeyProvider,
  type TtsProviderId,
  type TtsSettings,
  type TtsSettingsInfo,
  type TtsSettingsPatch,
  type TtsVoice,
} from "../../shared/tts";
import {
  blandSpeechRequest,
  blandVoicesRequest,
  decodeBase64AudioResponse,
  elevenLabsSpeechRequest,
  mergeTtsSettings,
  openaiSpeechRequest,
  parseBlandVoices,
  parseSayVoices,
  parseTtsSettings,
  providerErrorMessage,
  REMOTE_AUDIO_MIME,
  resolveApiKey,
  SAY_LIST_ARGS,
  sayArgs,
  SYSTEM_AUDIO_MIME,
  truncateForSpeech,
  ttsSettingsInfo,
  TTS_SETTINGS_FILENAME,
  vercelSpeechRequest,
  voiceLabel,
  type SpeechRequest,
  type TtsEnv,
} from "./tts-core";

/** A remote provider that has not answered in this long is not coming. */
const REMOTE_TIMEOUT_MS = 30_000;
/** `say` renders far faster than real time; this is a runaway guard. */
const SAY_TIMEOUT_MS = 60_000;

export interface SpeakRequest {
  /** The renderer's correlation id, so it can cancel this synthesis. */
  requestId: string;
  text: string;
  /** Overrides for a one-off (the settings page's voice preview). */
  provider?: TtsProviderId;
  voice?: string;
}

export interface TtsServiceDeps {
  userDataDir: string;
  env?: TtsEnv;
  platform?: string;
  /** Injected by tests; production uses the process-global fetch. */
  fetchImpl?: typeof fetch;
}

interface InFlight {
  cancel: () => void;
}

export class TtsService {
  private readonly filePath: string;
  private readonly env: TtsEnv;
  private readonly platform: string;
  private readonly fetchImpl: typeof fetch;
  private settingsCache: TtsSettings;
  private systemVoices: TtsVoice[] | null = null;
  private blandVoices: TtsVoice[] | null = null;
  private readonly inFlight = new Map<string, InFlight>();
  private stopped = false;

  constructor(deps: TtsServiceDeps) {
    this.filePath = path.join(deps.userDataDir, TTS_SETTINGS_FILENAME);
    this.env = deps.env ?? process.env;
    this.platform = deps.platform ?? process.platform;
    this.fetchImpl = deps.fetchImpl ?? ((input, init) => fetch(input, init));
    mkdirSync(deps.userDataDir, { recursive: true });
    this.settingsCache = this.read();
  }

  /* ------------------------------ settings ------------------------------ */

  private read(): TtsSettings {
    if (!existsSync(this.filePath)) {
      return {
        provider: DEFAULT_TTS_SETTINGS.provider,
        voices: { ...DEFAULT_TTS_SETTINGS.voices },
        models: { ...DEFAULT_TTS_SETTINGS.models },
        apiKeys: { ...DEFAULT_TTS_SETTINGS.apiKeys },
      };
    }
    try {
      return parseTtsSettings(readFileSync(this.filePath, "utf8"));
    } catch {
      return {
        provider: DEFAULT_TTS_SETTINGS.provider,
        voices: { ...DEFAULT_TTS_SETTINGS.voices },
        models: { ...DEFAULT_TTS_SETTINGS.models },
        apiKeys: { ...DEFAULT_TTS_SETTINGS.apiKeys },
      };
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

  /** The renderer-facing view: no key material, ever. */
  settings(): TtsSettingsInfo {
    return ttsSettingsInfo(this.settingsCache, this.env, this.platform);
  }

  updateSettings(patch: TtsSettingsPatch): TtsSettingsInfo {
    const previousKey = this.settingsCache.apiKeys.bland;
    this.settingsCache = mergeTtsSettings(this.settingsCache, patch);
    // A different Bland key is a different account, and therefore a different
    // set of cloned voices — the cached list belongs to the key that fetched it.
    if (this.settingsCache.apiKeys.bland !== previousKey) this.blandVoices = null;
    this.persist();
    return this.settings();
  }

  /**
   * The resolved credential for a remote provider (env first, then stored) —
   * for MAIN-process siblings that share a provider account, like the saves
   * extractor riding the same Vercel gateway key. Never crosses IPC.
   */
  apiKeyFor(provider: TtsKeyProvider): string | null {
    return resolveApiKey(provider, this.settingsCache, this.env);
  }

  /* ------------------------------- voices ------------------------------- */

  async voices(provider: TtsProviderId): Promise<TtsVoice[]> {
    if (provider === "bland") return this.blandVoiceList();
    if (provider !== "system") return [...staticVoices(provider)];
    if (this.platform !== "darwin") return [];
    if (this.systemVoices !== null) return [...this.systemVoices];
    try {
      const stdout = await this.run("say", [...SAY_LIST_ARGS], SAY_TIMEOUT_MS);
      this.systemVoices = parseSayVoices(stdout);
    } catch {
      // No `say`, or it refused to enumerate — an empty list means the page
      // offers "System default" only, which still speaks.
      this.systemVoices = [];
    }
    return [...this.systemVoices];
  }

  /**
   * Bland's voices are an ACCOUNT's, not a catalog: the three built-ins plus
   * whatever that key has cloned or added from the library. So the list is
   * fetched, and the shipped built-ins are the floor under every failure — no
   * key yet, no network, a rejected key — because a picker with three working
   * voices beats an empty one with an error in it. The result is cached for the
   * process and dropped when the key changes.
   */
  private async blandVoiceList(): Promise<TtsVoice[]> {
    if (this.blandVoices !== null) return [...this.blandVoices];
    const apiKey = resolveApiKey("bland", this.settingsCache, this.env);
    if (apiKey === null) return [...staticVoices("bland")];

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REMOTE_TIMEOUT_MS);
    try {
      const spec = blandVoicesRequest(apiKey);
      const response = await this.fetchImpl(spec.url, {
        headers: spec.headers,
        signal: controller.signal,
      });
      if (!response.ok) return [...staticVoices("bland")];
      const fetched = parseBlandVoices(await response.text());
      if (fetched.length === 0) return [...staticVoices("bland")];
      this.blandVoices = fetched;
      return [...fetched];
    } catch {
      return [...staticVoices("bland")];
    } finally {
      clearTimeout(timer);
    }
  }

  /* ------------------------------- speech ------------------------------- */

  async speak(request: SpeakRequest): Promise<TtsClip> {
    const settings = this.settingsCache;
    const provider = request.provider ?? settings.provider;
    const voice = request.voice ?? settings.voices[provider] ?? "";

    const stripped = stripForSpeech(request.text);
    if (stripped === "") throw new Error("There is nothing to read aloud.");
    const { text, truncated } = truncateForSpeech(stripped);

    // One cancel slot per request id: a renderer that re-speaks the same track
    // replaces its own pending synthesis rather than racing it.
    this.cancel(request.requestId);
    const controller = new AbortController();
    this.inFlight.set(request.requestId, { cancel: () => controller.abort() });
    try {
      const audio =
        provider === "system"
          ? await this.speakLocally(text, voice, controller.signal)
          : await this.speakRemotely(provider, text, voice, controller.signal);
      return {
        data: audio.data,
        mimeType: audio.mimeType,
        provider,
        voiceLabel: voiceLabel(provider, voice, this.knownVoices(provider)),
        truncated,
      };
    } finally {
      this.inFlight.delete(request.requestId);
    }
  }

  /**
   * The fetched voices for a provider that has them, for labelling only — each
   * cache is consulted for ITS provider, never as a fallback for another, or an
   * OpenAI voice would be looked up among this Mac's `say` voices and lose its
   * name.
   */
  private knownVoices(provider: TtsProviderId): readonly TtsVoice[] {
    if (provider === "system") return this.systemVoices ?? [];
    if (provider === "bland") return this.blandVoices ?? [];
    return [];
  }

  cancel(requestId: string): void {
    this.inFlight.get(requestId)?.cancel();
    this.inFlight.delete(requestId);
  }

  /** Teardown (sign-out, quit): nothing may outlive the service graph. */
  stop(): void {
    this.stopped = true;
    for (const entry of this.inFlight.values()) entry.cancel();
    this.inFlight.clear();
  }

  /* ---------------------------- the providers --------------------------- */

  private async speakLocally(
    text: string,
    voice: string,
    signal: AbortSignal,
  ): Promise<{ data: Uint8Array; mimeType: string }> {
    if (this.platform !== "darwin") {
      throw new Error(
        "The macOS voice is only available on macOS — pick a remote provider under Settings → Voice & audio.",
      );
    }
    const dir = path.join(tmpdir(), `suma-tts-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    const textFile = path.join(dir, "input.txt");
    const outFile = path.join(dir, "speech.wav");
    try {
      writeFileSync(textFile, text, "utf8");
      await this.run(
        "say",
        sayArgs({ voice, textFile, outFile }),
        SAY_TIMEOUT_MS,
        signal,
      );
      if (!existsSync(outFile)) {
        throw new Error("The macOS voice produced no audio.");
      }
      return {
        data: new Uint8Array(readFileSync(outFile)),
        mimeType: SYSTEM_AUDIO_MIME,
      };
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  }

  private async speakRemotely(
    provider: Exclude<TtsProviderId, "system">,
    text: string,
    voice: string,
    signal: AbortSignal,
  ): Promise<{ data: Uint8Array; mimeType: string }> {
    const apiKey = resolveApiKey(provider, this.settingsCache, this.env);
    if (apiKey === null) {
      const label = ttsProviderInfo(provider).label;
      throw new Error(
        `${label} needs an API key — add one under Settings → Voice & audio.`,
      );
    }
    if (voice.trim() === "") {
      throw new Error(
        `Pick a ${ttsProviderInfo(provider).label} voice under Settings → Voice & audio.`,
      );
    }
    const spec = this.speechRequest(provider, text, voice, apiKey);

    // Two ways to give up: the caller cancelled, or the provider went quiet.
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), REMOTE_TIMEOUT_MS);
    const onAbort = (): void => timeout.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const response = await this.fetchImpl(spec.url, {
        method: spec.method,
        headers: spec.headers,
        body: spec.body,
        signal: timeout.signal,
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(providerErrorMessage(provider, response.status, body));
      }
      const bytes =
        spec.responseKind === "base64-json"
          ? decodeBase64AudioResponse(await response.text())
          : new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength === 0) {
        throw new Error(
          `${ttsProviderInfo(provider).label} returned an empty clip.`,
        );
      }
      return { data: bytes, mimeType: REMOTE_AUDIO_MIME };
    } catch (err) {
      if (signal.aborted) throw new Error("Speech cancelled.");
      if (timeout.signal.aborted) {
        throw new Error(
          `${ttsProviderInfo(provider).label} did not answer in time.`,
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  }

  /**
   * The provider's own request shape. The gateway and Bland need one more input
   * than the fixed-model providers — WHICH speech model — and it comes from the
   * settings rather than from the caller, so a preview and a read-aloud always
   * agree on it.
   */
  private speechRequest(
    provider: Exclude<TtsProviderId, "system">,
    text: string,
    voice: string,
    apiKey: string,
  ): SpeechRequest {
    if (provider === "openai") return openaiSpeechRequest({ text, voice, apiKey });
    if (provider === "elevenlabs") {
      return elevenLabsSpeechRequest({ text, voice, apiKey });
    }
    const model = resolvedModel(provider, this.settingsCache.models);
    if (model === null) {
      throw new Error(
        `Pick a ${ttsProviderInfo(provider).label} speech model under Settings → Voice & audio.`,
      );
    }
    if (provider === "bland") {
      return blandSpeechRequest({ text, voice, model, apiKey });
    }
    return vercelSpeechRequest({ text, voice, model, apiKey });
  }

  /**
   * Spawn a command and resolve its stdout. `say` writes to a file rather than
   * a pipe, so stdout only matters for `-v ?`; stderr is the diagnostic when it
   * fails (an unknown voice name, most often).
   */
  private run(
    command: string,
    args: string[],
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      if (this.stopped) {
        reject(new Error("Speech cancelled."));
        return;
      }
      const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        fn();
      };
      const onAbort = (): void => {
        child.kill("SIGKILL");
        finish(() => reject(new Error("Speech cancelled.")));
      };
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(() => reject(new Error(`${command} timed out.`)));
      }, timeoutMs);

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("error", (err) => {
        finish(() => reject(err));
      });
      child.on("close", (code) => {
        finish(() => {
          if (code === 0) resolve(stdout);
          else {
            const detail = stderr.trim();
            reject(
              new Error(
                detail === ""
                  ? `${command} exited with code ${String(code)}`
                  : detail,
              ),
            );
          }
        });
      });
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}
