/**
 * Pure halves of the assistant's browser tools: the scripts injected into
 * pages and the sanitizers for what comes back.
 *
 * Everything a page returns is UNTRUSTED — the scripts run in the page's own
 * main world, so a hostile page can answer anything. The sanitizers therefore
 * never trust shapes: they clamp lengths, coerce types, and drop anything
 * unexpected, the same discipline as selection-core.ts and saves-core.ts.
 * What survives is plain text that goes into a model prompt, never anything
 * executed or trusted by the chrome.
 */

/** Page text beyond this is cut — enough to answer questions about an
 *  article, small enough not to blow the model's context on one tab. */
export const MAX_PAGE_TEXT_CHARS = 24_000;
/** Titles/urls/messages from the page get a shorter leash. */
const MAX_LINE_CHARS = 2_000;

function clampText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  // Strip control characters that would garble the prompt; keep newlines/tabs.
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned;
}

/* ------------------------------- read_page -------------------------------- */

/**
 * Reads the visible text of the document. innerText (not textContent) so
 * hidden templates and script bodies stay out; the fallback covers detached
 * or SVG-rooted bodies.
 */
export const READ_PAGE_SCRIPT = `(() => {
  const body = document.body;
  const text = body ? (body.innerText ?? body.textContent ?? "") : "";
  return {
    title: document.title || "",
    url: String(location.href || ""),
    text: String(text).slice(0, ${String(MAX_PAGE_TEXT_CHARS + 1_000)}),
  };
})()`;

export interface PageText {
  title: string;
  url: string;
  text: string;
}

export function sanitizePageText(raw: unknown): PageText {
  const record =
    typeof raw === "object" && raw !== null
      ? (raw as Record<string, unknown>)
      : {};
  return {
    title: clampText(record["title"], MAX_LINE_CHARS),
    url: clampText(record["url"], MAX_LINE_CHARS),
    text: clampText(record["text"], MAX_PAGE_TEXT_CHARS),
  };
}

/* ------------------------- click / type / scroll --------------------------- */

/**
 * Element lookup shared by the interaction scripts: a CSS selector, or a
 * case-insensitive substring of visible text over clickable-ish elements
 * (links, buttons, inputs, [role=button]). Serialized into each script.
 */
const FIND_ELEMENT_FN = `
  const findElement = (selector, text) => {
    if (selector) {
      try { return document.querySelector(selector); } catch { return null; }
    }
    if (!text) return null;
    const needle = String(text).toLowerCase();
    const candidates = document.querySelectorAll(
      'a, button, input, select, textarea, summary, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [onclick]'
    );
    let best = null;
    for (const el of candidates) {
      const label = (el.innerText || el.value || el.getAttribute('aria-label') || el.title || '')
        .trim().toLowerCase();
      if (!label || !label.includes(needle)) continue;
      // Prefer the tightest match — "Save" should not land on "Save as PDF".
      if (best === null || label.length < best.label.length) best = { el, label };
    }
    return best ? best.el : null;
  };
  const describe = (el) => {
    const tag = el.tagName.toLowerCase();
    const label = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 120);
    return label ? tag + ' "' + label + '"' : tag;
  };
`;

/** Click via a full pointer/mouse event sequence at the element's center —
 *  plain el.click() misses listeners bound to pointerdown/mouseup. */
export function clickScript(selector: string | null, text: string | null): string {
  return `(() => {
  ${FIND_ELEMENT_FN}
  const el = findElement(${JSON.stringify(selector)}, ${JSON.stringify(text)});
  if (!el) return { ok: false, message: "no matching element" };
  el.scrollIntoView({ block: "center", inline: "center" });
  const rect = el.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const opts = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0 };
  el.dispatchEvent(new PointerEvent("pointerdown", opts));
  el.dispatchEvent(new MouseEvent("mousedown", opts));
  el.dispatchEvent(new PointerEvent("pointerup", opts));
  el.dispatchEvent(new MouseEvent("mouseup", opts));
  el.click();
  return { ok: true, message: "clicked " + describe(el) };
})()`;
}

/** Focus the target (clearing it when asked); the actual characters are then
 *  inserted from main via webContents.insertText, which types like a user. */
export function focusForTypingScript(selector: string, clear: boolean): string {
  return `(() => {
  ${FIND_ELEMENT_FN}
  const el = findElement(${JSON.stringify(selector)}, null);
  if (!el) return { ok: false, message: "no matching element" };
  el.scrollIntoView({ block: "center", inline: "center" });
  el.focus();
  if (${clear ? "true" : "false"}) {
    if (typeof el.select === "function") el.select();
    else if (el.isContentEditable) {
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = getSelection();
      if (sel) { sel.removeAllRanges(); sel.addRange(range); }
    }
  }
  return { ok: true, message: "focused " + describe(el) };
})()`;
}

export function scrollScript(
  direction: "up" | "down" | "top" | "bottom" | null,
  selector: string | null,
): string {
  return `(() => {
  ${FIND_ELEMENT_FN}
  const selector = ${JSON.stringify(selector)};
  if (selector) {
    const el = findElement(selector, null);
    if (!el) return { ok: false, message: "no matching element" };
    el.scrollIntoView({ block: "center" });
    return { ok: true, message: "scrolled to " + describe(el) };
  }
  const page = document.scrollingElement || document.documentElement;
  const dir = ${JSON.stringify(direction ?? "down")};
  if (dir === "top") page.scrollTo({ top: 0 });
  else if (dir === "bottom") page.scrollTo({ top: page.scrollHeight });
  else page.scrollBy({ top: (dir === "up" ? -0.85 : 0.85) * innerHeight });
  return {
    ok: true,
    message: "scrolled " + dir + " — now at " + Math.round(page.scrollTop) +
      " of " + Math.round(page.scrollHeight - innerHeight) + "px",
  };
})()`;
}

export interface ScriptOutcome {
  ok: boolean;
  message: string;
}

export function sanitizeScriptOutcome(raw: unknown): ScriptOutcome {
  const record =
    typeof raw === "object" && raw !== null
      ? (raw as Record<string, unknown>)
      : {};
  return {
    ok: record["ok"] === true,
    message: clampText(record["message"], MAX_LINE_CHARS) || "no result",
  };
}

/* -------------------------------- press_key -------------------------------- */

/**
 * The named keys press_key accepts, mapped to Electron sendInputEvent
 * keyCodes. sendInputEvent (not injected JS events) so the page receives
 * trusted key events — form submission on Enter works.
 */
export const PRESS_KEYS: Record<string, string> = {
  enter: "Return",
  tab: "Tab",
  escape: "Escape",
  backspace: "Backspace",
  delete: "Delete",
  arrowup: "Up",
  arrowdown: "Down",
  arrowleft: "Left",
  arrowright: "Right",
  pageup: "PageUp",
  pagedown: "PageDown",
  home: "Home",
  end: "End",
};

export function resolvePressKey(name: string): string | null {
  return PRESS_KEYS[name.trim().toLowerCase()] ?? null;
}
