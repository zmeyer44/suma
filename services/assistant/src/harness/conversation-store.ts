import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import type { AssistantConversationStore } from "./ai-sdk-harness";

const MAX_MESSAGES = 100;
const MAX_PLAINTEXT_BYTES = 8 * 1024 * 1024;

interface ConversationEnvelope {
  version: 1;
  nonce: string;
  ciphertext: string;
  tag: string;
}

export class EncryptedFileAssistantConversationStore
  implements AssistantConversationStore
{
  readonly #directory: string;
  readonly #key: Buffer;
  readonly #tails = new Map<string, Promise<void>>();

  constructor(directory: string, masterKey: Uint8Array) {
    if (masterKey.byteLength !== 32) {
      throw new Error("conversation master key must be exactly 32 bytes");
    }
    this.#directory = directory;
    this.#key = Buffer.from(masterKey);
  }

  load(conversationId: string): Promise<ModelMessage[]> {
    return this.#exclusive(conversationId, async () => {
      let encoded: string;
      try {
        encoded = await readFile(this.#path(conversationId), "utf8");
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") return [];
        throw error;
      }
      const envelope = JSON.parse(encoded) as ConversationEnvelope;
      if (envelope.version !== 1) {
        throw new Error("unsupported assistant conversation version");
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
      return JSON.parse(plaintext.toString("utf8")) as ModelMessage[];
    });
  }

  save(conversationId: string, messages: ModelMessage[]): Promise<void> {
    return this.#exclusive(conversationId, async () => {
      await mkdir(this.#directory, { recursive: true, mode: 0o700 });
      let retained = messages.slice(-MAX_MESSAGES);
      let plaintext = Buffer.from(JSON.stringify(retained), "utf8");
      while (plaintext.byteLength > MAX_PLAINTEXT_BYTES && retained.length > 1) {
        retained = retained.slice(Math.ceil(retained.length / 4));
        plaintext = Buffer.from(JSON.stringify(retained), "utf8");
      }
      if (plaintext.byteLength > MAX_PLAINTEXT_BYTES) {
        throw new Error("assistant conversation turn exceeds storage limit");
      }
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", this.#key, nonce);
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const envelope: ConversationEnvelope = {
        version: 1,
        nonce: nonce.toString("base64"),
        ciphertext: ciphertext.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
      };
      const path = this.#path(conversationId);
      const temporary = `${path}.${String(process.pid)}.${randomBytes(6).toString("hex")}.tmp`;
      await writeFile(temporary, JSON.stringify(envelope), { mode: 0o600 });
      await rename(temporary, path);
    });
  }

  #path(conversationId: string): string {
    const digest = createHash("sha256").update(conversationId).digest("hex");
    return join(this.#directory, `${digest}.conversation`);
  }

  #exclusive<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(id) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    this.#tails.set(
      id,
      result.then(
        () => undefined,
        () => undefined,
      ),
    );
    return result;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
