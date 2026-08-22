import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  AssistantTaskRecord,
  AssistantTaskStore,
} from "@suma/assistant-core/channel";

interface TaskFileEnvelope {
  version: 1;
  nonce: string;
  ciphertext: string;
  tag: string;
}

interface TaskFileState {
  tasks: AssistantTaskRecord[];
}

/** Single-process durable queue. Production may replace this with Postgres. */
export class EncryptedFileAssistantTaskStore implements AssistantTaskStore {
  readonly #path: string;
  readonly #key: Buffer;
  #tail: Promise<void> = Promise.resolve();

  constructor(path: string, masterKey: Uint8Array) {
    if (masterKey.byteLength !== 32) {
      throw new Error("assistant task master key must be exactly 32 bytes");
    }
    this.#path = path;
    this.#key = Buffer.from(masterKey);
  }

  enqueue(task: AssistantTaskRecord): Promise<AssistantTaskRecord> {
    return this.#exclusive(async () => {
      const state = await this.#load();
      const existing = state.tasks.find(
        (candidate) => candidate.dedupeKey === task.dedupeKey,
      );
      if (existing !== undefined) return existing;
      state.tasks.push(task);
      await this.#save(state);
      return task;
    });
  }

  claimNext(): Promise<AssistantTaskRecord | null> {
    return this.#exclusive(async () => {
      const state = await this.#load();
      const task = state.tasks.find((candidate) => candidate.status === "queued");
      if (task === undefined) return null;
      task.status = "running";
      task.updatedAt = new Date().toISOString();
      await this.#save(state);
      return { ...task };
    });
  }

  update(
    id: string,
    patch: Pick<AssistantTaskRecord, "status" | "updatedAt"> & {
      error?: string;
    },
  ): Promise<void> {
    return this.#exclusive(async () => {
      const state = await this.#load();
      const task = state.tasks.find((candidate) => candidate.id === id);
      if (task === undefined) throw new Error(`unknown assistant task ${id}`);
      task.status = patch.status;
      task.updatedAt = patch.updatedAt;
      if (patch.error === undefined) delete task.error;
      else task.error = patch.error;
      await this.#save(state);
    });
  }

  findByDedupeKey(dedupeKey: string): Promise<AssistantTaskRecord | null> {
    return this.#exclusive(async () => {
      const state = await this.#load();
      const task = state.tasks.find(
        (candidate) => candidate.dedupeKey === dedupeKey,
      );
      return task === undefined ? null : { ...task };
    });
  }

  recoverInterrupted(): Promise<number> {
    return this.#exclusive(async () => {
      const state = await this.#load();
      let recovered = 0;
      for (const task of state.tasks) {
        if (task.status !== "running") continue;
        task.status = "queued";
        task.updatedAt = new Date().toISOString();
        recovered += 1;
      }
      if (recovered > 0) await this.#save(state);
      return recovered;
    });
  }

  async #load(): Promise<TaskFileState> {
    let encoded: string;
    try {
      encoded = await readFile(this.#path, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return { tasks: [] };
      throw error;
    }
    const envelope = JSON.parse(encoded) as TaskFileEnvelope;
    if (envelope.version !== 1) {
      throw new Error("unsupported assistant task file version");
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
    return JSON.parse(plaintext.toString("utf8")) as TaskFileState;
  }

  async #save(state: TaskFileState): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, nonce);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(state), "utf8"),
      cipher.final(),
    ]);
    const envelope: TaskFileEnvelope = {
      version: 1,
      nonce: nonce.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
    };
    const temporary = `${this.#path}.${String(process.pid)}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(temporary, JSON.stringify(envelope), { mode: 0o600 });
    await rename(temporary, this.#path);
  }

  #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation, operation);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
