/**
 * The guest-page NIP-07 preload — `window.nostr` for every site tab.
 *
 * Deliberately NOT part of the bundled preload: guest tabs are sandboxed
 * (tabs.ts), and a sandboxed renderer cannot load an ESM preload, so this is
 * a single dependency-free CommonJS file (electron.vite.config.ts copies it
 * verbatim to out/preload/). It is registered per SPACE session
 * (main/nostr/guest-preload.ts) — the chrome, overlay, and files surfaces
 * never see it, and OAuth popups (same session) do.
 *
 * Trust: this bridge carries method calls only. The page's arguments go to
 * main untouched and UNTRUSTED — main re-validates every shape and resolves
 * the caller's host from the sender frame, never from anything here. Errors
 * come back as values and are re-thrown so `window.nostr` behaves like the
 * NIP-07 extensions sites already handle.
 */

/* eslint-disable @typescript-eslint/no-require-imports */
/* global require -- sandboxed preloads get Electron's require shim, not Node's module scope */
"use strict";

const { contextBridge, ipcRenderer } = require("electron");

/** Must match NOSTR_GUEST_CHANNEL in src/shared/nostr.ts. */
const CHANNEL = "nostr:guest-call";

/**
 * @param {Record<string, unknown>} payload
 * @returns {Promise<unknown>}
 */
async function call(payload) {
  let reply;
  try {
    reply = await ipcRenderer.invoke(CHANNEL, payload);
  } catch {
    throw new Error("window.nostr: the signer is unavailable");
  }
  if (typeof reply !== "object" || reply === null || reply.ok !== true) {
    const message =
      typeof reply === "object" && reply !== null && typeof reply.error === "string"
        ? reply.error
        : "window.nostr: request failed";
    throw new Error(message);
  }
  return reply.result;
}

contextBridge.exposeInMainWorld("nostr", {
  /** @returns {Promise<string>} hex public key */
  getPublicKey: () => call({ method: "getPublicKey" }),
  /** @param {unknown} event @returns {Promise<unknown>} the signed event */
  signEvent: (event) => call({ method: "signEvent", event }),
  /** @returns {Promise<Record<string, {read: boolean, write: boolean}>>} */
  getRelays: () => call({ method: "getRelays" }),
  nip04: {
    /** @param {unknown} peer @param {unknown} plaintext */
    encrypt: (peer, plaintext) =>
      call({ method: "nip04.encrypt", peer, plaintext }),
    /** @param {unknown} peer @param {unknown} ciphertext */
    decrypt: (peer, ciphertext) =>
      call({ method: "nip04.decrypt", peer, ciphertext }),
  },
  nip44: {
    /** @param {unknown} peer @param {unknown} plaintext */
    encrypt: (peer, plaintext) =>
      call({ method: "nip44.encrypt", peer, plaintext }),
    /** @param {unknown} peer @param {unknown} ciphertext */
    decrypt: (peer, ciphertext) =>
      call({ method: "nip44.decrypt", peer, ciphertext }),
  },
});
