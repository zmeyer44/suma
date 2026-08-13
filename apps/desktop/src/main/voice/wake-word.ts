/**
 * WakeWordEngine — the always-on, on-device trigger ("Suma, …").
 *
 * Detection is a sherpa-onnx transducer keyword spotter (~3.3M params, CPU,
 * offline): nothing the microphone hears leaves this Mac while the assistant
 * is merely ARMED. Cloud audio starts only after a detection (or ⌥Space)
 * opens a live session — that boundary is the whole point of a wake word.
 *
 * Two soft dependencies, both handled by degrading to "unavailable" instead
 * of failing the feature (push-to-talk keeps working without them):
 *
 *  - `sherpa-onnx-node` is a native N-API addon, loaded lazily via dynamic
 *    import so a build/platform where it cannot load costs nothing.
 *  - The model files (~15 MB) are not bundled; they download once from the
 *    sherpa-onnx release into userData/voice-models and are reused forever.
 *    macOS `tar` unpacks the .tar.bz2 (Node has no bzip2).
 *
 * The wake phrase is arbitrary text: encodeKeyword (voice-core.ts) turns
 * "suma" into BPE pieces from the model's own vocabulary, so re-arming with
 * a new phrase is a settings write, not a model download.
 */

import { spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  buildKeywordsFile,
  parseTokenVocabulary,
  pcm16ToFloat32,
} from "./voice-core";

const MODEL_DIR_NAME = "kws-zipformer-gigaspeech-3.3M";
const MODEL_URL =
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01.tar.bz2";
/** The directory name inside the release tarball. */
const MODEL_TAR_ROOT = "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01";

/** int8 weights: same detection quality for this task, third of the size. */
const MODEL_FILES = {
  encoder: "encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx",
  decoder: "decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx",
  joiner: "joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx",
  tokens: "tokens.txt",
} as const;

const SAMPLE_RATE = 16_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;

/** The slice of the sherpa-onnx addon this engine touches. */
interface SherpaModule {
  KeywordSpotter: new (config: unknown) => SherpaKeywordSpotter;
}

interface SherpaStream {
  acceptWaveform(input: { sampleRate: number; samples: Float32Array }): void;
}

interface SherpaKeywordSpotter {
  createStream(): SherpaStream;
  isReady(stream: SherpaStream): boolean;
  decode(stream: SherpaStream): void;
  getResult(stream: SherpaStream): { keyword: string };
  reset(stream: SherpaStream): void;
}

export interface WakeWordDeps {
  /** userData/voice-models — models survive sign-out (they hold no user data). */
  modelsDir: string;
  /** Injected by tests. Defaults to the real dynamic import. */
  loadSherpa?: () => Promise<SherpaModule>;
  fetchImpl?: typeof fetch;
}

export class WakeWordEngine {
  private readonly deps: WakeWordDeps;
  private spotter: SherpaKeywordSpotter | null = null;
  private stream: SherpaStream | null = null;
  private disposed = false;

  constructor(deps: WakeWordDeps) {
    this.deps = deps;
  }

  private get modelDir(): string {
    return path.join(this.deps.modelsDir, MODEL_DIR_NAME);
  }

  modelPresent(): boolean {
    return Object.values(MODEL_FILES).every((file) =>
      existsSync(path.join(this.modelDir, file)),
    );
  }

  /**
   * Fetch and unpack the model. Idempotent; safe to call when present.
   * Throws with a user-readable message on network/unpack failure.
   */
  async ensureModel(): Promise<void> {
    if (this.modelPresent()) return;
    const fetchImpl = this.deps.fetchImpl ?? fetch;
    await mkdir(this.modelDir, { recursive: true });
    const archive = path.join(this.modelDir, "model.tar.bz2");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    try {
      const response = await fetchImpl(MODEL_URL, {
        signal: controller.signal,
      });
      if (!response.ok || response.body === null) {
        throw new Error(
          `wake-word model download failed (HTTP ${String(response.status)})`,
        );
      }
      await pipeline(
        Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
        createWriteStream(archive),
      );
      // --strip-components flattens the tarball's root dir into modelDir.
      await this.untar(archive);
      if (!this.modelPresent()) {
        throw new Error("wake-word model archive was missing expected files");
      }
    } catch (err) {
      if (controller.signal.aborted) {
        throw new Error("wake-word model download timed out");
      }
      throw err;
    } finally {
      clearTimeout(timer);
      await rm(archive, { force: true });
    }
  }

  private untar(archive: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn("tar", [
        "-xjf",
        archive,
        "-C",
        this.modelDir,
        "--strip-components",
        "1",
        `${MODEL_TAR_ROOT}/${MODEL_FILES.encoder}`,
        `${MODEL_TAR_ROOT}/${MODEL_FILES.decoder}`,
        `${MODEL_TAR_ROOT}/${MODEL_FILES.joiner}`,
        `${MODEL_TAR_ROOT}/${MODEL_FILES.tokens}`,
      ]);
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => (stderr += chunk));
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`tar failed: ${stderr.trim() || String(code)}`));
      });
    });
  }

  /**
   * Arm the spotter for `phrase`. Requires the model on disk. Throws when
   * the native module cannot load or the phrase cannot be encoded — the
   * caller reports "unavailable" and keeps push-to-talk.
   */
  async arm(phrase: string): Promise<void> {
    const vocabulary = parseTokenVocabulary(
      await readFile(path.join(this.modelDir, MODEL_FILES.tokens), "utf8"),
    );
    const contents = buildKeywordsFile(phrase, vocabulary);
    if (contents === null) {
      throw new Error(`the wake word "${phrase}" cannot be encoded`);
    }
    const keywordsFile = path.join(this.modelDir, "keywords-active.txt");
    await writeFile(keywordsFile, contents, "utf8");

    // sherpa-onnx-node is CJS (`module.exports = {…}`); imported dynamically
    // from ESM its classes land on `.default`, not the namespace itself.
    const load =
      this.deps.loadSherpa ??
      (async () => {
        const namespace = (await import("sherpa-onnx-node")) as {
          default?: SherpaModule;
        } & Partial<SherpaModule>;
        return typeof namespace.KeywordSpotter === "function"
          ? (namespace as SherpaModule)
          : (namespace.default as SherpaModule);
      });
    const sherpa = await load();
    if (this.disposed) return;
    this.spotter = new sherpa.KeywordSpotter({
      featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
      modelConfig: {
        transducer: {
          encoder: path.join(this.modelDir, MODEL_FILES.encoder),
          decoder: path.join(this.modelDir, MODEL_FILES.decoder),
          joiner: path.join(this.modelDir, MODEL_FILES.joiner),
        },
        tokens: path.join(this.modelDir, MODEL_FILES.tokens),
        numThreads: 1,
        provider: "cpu",
        debug: 0,
      },
      keywordsFile,
      // Well below the 0.25 default, measured on synthesized speech: a wake
      // word runs together with the words after it ("suma open a tab"), and
      // above ~0.1 those utterance-initial detections miss. The price is
      // that a true homophone can wake it ("assume a…") — the standard
      // short-wake-word trade, and a false wake is visible in the HUD and
      // closes itself, while a missed command reads as "it doesn't work".
      keywordsThreshold: 0.1,
    });
    this.stream = this.spotter.createStream();
  }

  get armed(): boolean {
    return this.spotter !== null && this.stream !== null;
  }

  /**
   * Feed one mic frame (16 kHz PCM16 bytes). True exactly when the wake
   * phrase completed inside this frame; the stream is reset so back-to-back
   * detections need a fresh utterance.
   */
  feed(frame: Uint8Array): boolean {
    const spotter = this.spotter;
    const stream = this.stream;
    if (spotter === null || stream === null) return false;
    stream.acceptWaveform({
      sampleRate: SAMPLE_RATE,
      samples: pcm16ToFloat32(frame),
    });
    let hit = false;
    while (spotter.isReady(stream)) {
      spotter.decode(stream);
      if (spotter.getResult(stream).keyword !== "") {
        hit = true;
        spotter.reset(stream);
      }
    }
    return hit;
  }

  /** Disarm (settings change, session teardown). The model stays on disk. */
  dispose(): void {
    this.disposed = true;
    this.spotter = null;
    this.stream = null;
  }
}
