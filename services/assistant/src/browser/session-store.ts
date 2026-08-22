import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BrowserContext } from "playwright-core";

export interface BrowserSessionKey {
  userId: string;
  spaceId: string;
}

export type BrowserStorageState = Awaited<
  ReturnType<BrowserContext["storageState"]>
>;

export interface BrowserSessionStore {
  load(key: BrowserSessionKey): Promise<BrowserStorageState | null>;
  save(key: BrowserSessionKey, state: BrowserStorageState): Promise<void>;
}

interface EncryptedEnvelope {
  version: 1;
  nonce: string;
  ciphertext: string;
  tag: string;
}

/**
 * Cookie and local-storage state is account access. It is encrypted at rest,
 * written atomically, and never placed on the compute VM.
 */
export class EncryptedFileBrowserSessionStore
  implements BrowserSessionStore
{
  readonly #directory: string;
  readonly #key: Buffer;

  constructor(directory: string, masterKey: Uint8Array) {
    if (masterKey.byteLength !== 32) {
      throw new Error("browser session master key must be exactly 32 bytes");
    }
    this.#directory = directory;
    this.#key = Buffer.from(masterKey);
  }

  async load(key: BrowserSessionKey): Promise<BrowserStorageState | null> {
    let encoded: string;
    try {
      encoded = await readFile(this.#pathFor(key), "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      throw error;
    }

    const envelope = JSON.parse(encoded) as EncryptedEnvelope;
    if (envelope.version !== 1) {
      throw new Error("unsupported browser session envelope version");
    }
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.#key,
      Buffer.from(envelope.nonce, "base64"),
    );
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")),
      decipher.final(),
    ]);
    return JSON.parse(plaintext.toString("utf8")) as BrowserStorageState;
  }

  async save(
    key: BrowserSessionKey,
    state: BrowserStorageState,
  ): Promise<void> {
    const path = this.#pathFor(key);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, nonce);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(state), "utf8"),
      cipher.final(),
    ]);
    const envelope: EncryptedEnvelope = {
      version: 1,
      nonce: nonce.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
    };
    const temporary = `${path}.${String(process.pid)}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(temporary, JSON.stringify(envelope), { mode: 0o600 });
    await rename(temporary, path);
  }

  #pathFor(key: BrowserSessionKey): string {
    const digest = createHash("sha256")
      .update(`${key.userId}\u0000${key.spaceId}`)
      .digest("hex");
    return join(this.#directory, `${digest}.session`);
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
