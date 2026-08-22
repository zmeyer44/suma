import type {
  BrowserSessionKey,
  BrowserSessionStore,
  BrowserStorageState,
} from "./session-store";

const MAX_STATE_BYTES = 8 * 1024 * 1024;
const MAX_COOKIES = 2_000;
const MAX_ORIGINS = 500;
const MAX_LOCAL_STORAGE_ITEMS = 10_000;

/** Validates a trusted desktop-to-browser-plane session handoff. */
export class BrowserSessionTransferService {
  readonly #store: BrowserSessionStore;

  constructor(store: BrowserSessionStore) {
    this.#store = store;
  }

  async import(key: BrowserSessionKey, value: unknown): Promise<void> {
    const state = parseBrowserStorageState(value);
    await this.#store.save(key, state);
  }

  async export(key: BrowserSessionKey): Promise<BrowserStorageState | null> {
    return this.#store.load(key);
  }
}

export function parseBrowserStorageState(value: unknown): BrowserStorageState {
  const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
  if (bytes > MAX_STATE_BYTES) {
    throw new Error("browser session handoff exceeds the 8 MiB limit");
  }
  if (!isRecord(value)) throw new Error("browser session handoff must be an object");
  const cookies = value["cookies"];
  const origins = value["origins"];
  if (!Array.isArray(cookies) || cookies.length > MAX_COOKIES) {
    throw new Error("browser session handoff has an invalid cookie list");
  }
  if (!Array.isArray(origins) || origins.length > MAX_ORIGINS) {
    throw new Error("browser session handoff has an invalid origin list");
  }
  for (const cookie of cookies) {
    if (
      !isRecord(cookie) ||
      typeof cookie["name"] !== "string" ||
      typeof cookie["value"] !== "string" ||
      typeof cookie["domain"] !== "string" ||
      typeof cookie["path"] !== "string"
    ) {
      throw new Error("browser session handoff contains an invalid cookie");
    }
  }
  let itemCount = 0;
  for (const origin of origins) {
    if (!isRecord(origin) || typeof origin["origin"] !== "string") {
      throw new Error("browser session handoff contains an invalid origin");
    }
    const url = new URL(origin["origin"]);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.origin !== origin["origin"]
    ) {
      throw new Error("browser session handoff origin must be an HTTP(S) origin");
    }
    const localStorage = origin["localStorage"];
    if (!Array.isArray(localStorage)) {
      throw new Error("browser session handoff has invalid local storage");
    }
    itemCount += localStorage.length;
    if (itemCount > MAX_LOCAL_STORAGE_ITEMS) {
      throw new Error("browser session handoff has too many local storage items");
    }
    for (const item of localStorage) {
      if (
        !isRecord(item) ||
        typeof item["name"] !== "string" ||
        typeof item["value"] !== "string"
      ) {
        throw new Error("browser session handoff contains invalid local storage");
      }
    }
  }
  return value as BrowserStorageState;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
