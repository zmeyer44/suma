// REPL driver for the Suma Electron desktop app (macOS, headed).
//
// Designed for agents: run inside tmux, send-keys commands, capture-pane the
// output. Launches the BUILT app (out/main/index.js) — run `pnpm build` in
// apps/desktop first.
//
// Env passthrough that matters:
//   SUMA_CONTROL_URL  point the app at a control plane (e.g. a local
//                       services/control on http://127.0.0.1:8790)
//   SUMA_AGENT_URL / SUMA_EGRESS_URL  as in normal dev
//   SCREENSHOT_DIR      where ss/sscomp write PNGs (default /tmp/suma-shots)
//
// PROFILE: launching the raw Electron binary keeps the default app name
// "Electron", so userData resolves to ~/Library/Application Support/Electron
// — a scratch profile, NOT the developer's real one (`pnpm dev` runs under
// electron-vite, which applies the app name and uses .../@suma/desktop).
// $HOME does not move it: Electron resolves ~/Library via the OS user
// record. To reset driver state between validation flows, delete
// device.json + workspace.json from the Electron scratch directory.

import { _electron as electron } from "playwright-core";
import * as readline from "node:readline";
import * as fs from "node:fs";
import * as path from "node:path";

const APP_DIR = path.resolve(import.meta.dirname, "../../..");
const SHOT_DIR = process.env.SCREENSHOT_DIR || "/tmp/suma-shots";
fs.mkdirSync(SHOT_DIR, { recursive: true });

let app = null;
let page = null; // the chrome renderer page

const electronBin = path.join(
  APP_DIR,
  "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
);

function chromePage() {
  // The auxiliary pages (#save-preview, #selection-toolbar, and any future
  // fragment-routed sibling) share the bundle URL — never bind the
  // chrome-scoped commands to one, whatever order the windows enumerate in.
  return (
    app
      .windows()
      .find(
        (w) =>
          w.url().includes("renderer/index.html") && !w.url().includes("#"),
      ) ?? null
  );
}

const COMMANDS = {
  async launch() {
    if (app) return console.log("already launched");
    app = await electron.launch({
      executablePath: electronBin,
      args: [path.join(APP_DIR, "out/main/index.js")],
      cwd: APP_DIR,
      env: { ...process.env },
      // Playwright emulates prefers-color-scheme: light by default, which
      // would pin the chrome to a light palette no matter what this Mac (or
      // nativeTheme) says — the renderer picks its default theme from that
      // query. null turns the emulation off so the app sees the real thing.
      colorScheme: null,
      timeout: 30_000,
    });
    for (let i = 0; i < 50 && !page; i++) {
      await new Promise((r) => setTimeout(r, 200));
      page = chromePage();
    }
    if (!page) return console.log("ERROR: chrome page never appeared");
    await page.waitForSelector("aside", { timeout: 15_000 }).catch(() => {});
    console.log("launched.", app.windows().length, "windows:");
    for (const w of app.windows()) console.log("  ", w.url());
  },

  // CDP screenshot of the chrome renderer only (sidebar + overlays). Cheap,
  // but does NOT show the tab WebContentsViews layered above the chrome.
  async ss(name) {
    if (!page) return console.log("ERROR: launch first");
    const f = path.join(SHOT_DIR, (name || `ss-${Date.now()}`) + ".png");
    await page.screenshot({ path: f });
    console.log("screenshot:", f);
  },

  // Composite of the real window WITHOUT macOS screen-recording permission:
  // capture every visible WebContentsView via Chromium's own compositor and
  // reassemble them at their true bounds in an offscreen window. This is the
  // command that shows split view, tab content, and raised overlays together.
  async sscomp(name) {
    if (!app) return console.log("ERROR: launch first");
    const b64 = await app.evaluate(async ({ BaseWindow, BrowserWindow }) => {
      // The SHELL is the one plain BaseWindow; BrowserWindows are floating
      // overlays (the save-preview/audio-player window) captured below.
      const win = BaseWindow.getAllWindows().find(
        (w) => !w.isDestroyed() && !(w instanceof BrowserWindow),
      );
      if (!win) return null;
      const [w, h] = win.getContentSize();
      const pieces = [];
      for (const child of win.contentView.children) {
        const wc = child.webContents;
        if (!wc || wc.isDestroyed() || !child.getVisible()) continue;
        const bounds = child.getBounds();
        const img = await wc.capturePage();
        if (img.isEmpty()) continue;
        pieces.push({ bounds, data: img.toDataURL() });
      }
      // Floating overlay windows, placed shell-content-relative. capturePage
      // keeps the page's own alpha, so their transparent margins stay
      // see-through in the composite.
      const content = win.getContentBounds();
      for (const bw of BrowserWindow.getAllWindows()) {
        if (bw.isDestroyed() || !bw.isVisible()) continue;
        const img = await bw.webContents.capturePage();
        if (img.isEmpty()) continue;
        const b = bw.getBounds();
        pieces.push({
          bounds: {
            x: b.x - content.x,
            y: b.y - content.y,
            width: b.width,
            height: b.height,
          },
          data: img.toDataURL(),
        });
      }
      const html =
        `<body style="margin:0;position:relative;width:${w}px;height:${h}px;background:#0f1115">` +
        pieces
          .map(
            (p) =>
              `<img src="${p.data}" style="position:absolute;left:${p.bounds.x}px;top:${p.bounds.y}px;width:${p.bounds.width}px;height:${p.bounds.height}px">`,
          )
          .join("") +
        `</body>`;
      const comp = new BrowserWindow({
        show: false,
        width: w,
        height: h,
        webPreferences: { offscreen: true },
      });
      await comp.loadURL("data:text/html;base64," + Buffer.from(html).toString("base64"));
      await new Promise((r) => setTimeout(r, 1200));
      const shot = await comp.webContents.capturePage();
      comp.destroy();
      return shot.toPNG().toString("base64");
    });
    if (!b64) return console.log("ERROR: no window/pieces");
    const f = path.join(SHOT_DIR, (name || `comp-${Date.now()}`) + ".png");
    fs.writeFileSync(f, Buffer.from(b64, "base64"));
    console.log("screenshot:", f);
  },

  // DOM click, never coordinates: the UI lives in WebContentsViews, so
  // Playwright's coordinate math would hit the wrong layer.
  async click(sel) {
    if (!page) return console.log("ERROR: launch first");
    const r = await page.evaluate((s) => {
      const el = document.querySelector(s);
      if (!el) return "NOT_FOUND";
      el.click();
      return "OK";
    }, sel);
    console.log("click", sel, "→", r);
  },

  // Real pointer move to the element's center — the one thing `click` cannot
  // stand in for, since CSS :hover ignores synthetic events. Coordinates are
  // safe HERE because the chrome view spans the window and the strip is the
  // part of it no tab view covers; do not expect it to work over page content.
  async hover(sel) {
    if (!page) return console.log("ERROR: launch first");
    const box = await page
      .locator(sel)
      .first()
      .boundingBox()
      .catch(() => null);
    if (!box) return console.log("hover", sel, "→ NOT_FOUND");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    console.log("hover", sel, "→ OK");
  },

  // Real mouse click at the element's center (Playwright CSS pierces open
  // shadow roots). Same coordinate caveat as hover: trustworthy only over
  // chrome the tab views don't cover — internal pages (suma://terminal's
  // editor) qualify. Needed where a caret must be placed: synthetic .click()
  // never produces a selection, so editors ignore it.
  async mclick(sel) {
    if (!page) return console.log("ERROR: launch first");
    const box = await page
      .locator(sel)
      .first()
      .boundingBox()
      .catch(() => null);
    if (!box) return console.log("mclick", sel, "→ NOT_FOUND");
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    console.log("mclick", sel, "→ OK");
  },

  // Real mouse drag from the element's center by dx,dy — for splitters and
  // anything else that only listens to pointermove. Same chrome-only
  // coordinate caveat as hover/mclick. Usage: mdrag <sel> <dx> <dy>
  async mdrag(arg) {
    if (!page) return console.log("ERROR: launch first");
    const [sel, dx, dy] = arg.split(/\s+/);
    const box = await page
      .locator(sel)
      .first()
      .boundingBox()
      .catch(() => null);
    if (!box) return console.log("mdrag", sel, "→ NOT_FOUND");
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + Number(dx), y + Number(dy), { steps: 8 });
    await page.mouse.up();
    console.log("mdrag", sel, "→ OK");
  },

  async "click-text"(text) {
    if (!page) return console.log("ERROR: launch first");
    const r = await page.evaluate((t) => {
      const els = [...document.querySelectorAll('button, a, [role="button"]')];
      const el =
        els.find((e) => e.textContent?.trim() === t) ??
        els.find((e) => e.textContent?.includes(t));
      if (!el) return "NOT_FOUND";
      el.click();
      return "OK: " + (el.getAttribute("aria-label") ?? el.tagName);
    }, text);
    console.log("click-text", JSON.stringify(text), "→", r);
  },

  // Focus an input and type real key events into it. Works for most inputs;
  // if focus is contested, use setval instead.
  async fill(arg) {
    if (!page) return console.log("ERROR: launch first");
    const idx = arg.indexOf(" ");
    const sel = arg.slice(0, idx);
    const text = arg.slice(idx + 1);
    const ok = await page.evaluate((s) => {
      const el = document.querySelector(s);
      if (!el) return false;
      el.focus();
      return true;
    }, sel);
    if (!ok) return console.log("NOT_FOUND:", sel);
    await page.keyboard.type(text, { delay: 15 });
    console.log("filled", sel);
  },

  // Set a React-controlled input's value via the native setter + an 'input'
  // event — the reliable path when keyboard focus is not where you think.
  async setval(arg) {
    if (!page) return console.log("ERROR: launch first");
    const idx = arg.indexOf(" ");
    const sel = arg.slice(0, idx);
    const value = arg.slice(idx + 1);
    const r = await page.evaluate(
      ({ s, v }) => {
        const el = document.querySelector(s);
        if (!el) return "NOT_FOUND";
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        if (!set) return "NO_SETTER";
        set.call(el, v);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        return "OK";
      },
      { s: sel, v: value },
    );
    console.log("setval", sel, "→", r);
  },

  async press(key) {
    if (page) await page.keyboard.press(key);
    console.log("pressed", key);
  },

  async type(text) {
    if (page) await page.keyboard.type(text, { delay: 20 });
    console.log("typed");
  },

  async text(sel) {
    if (!page) return console.log("ERROR: launch first");
    console.log(
      await page.evaluate(
        (s) => (s ? document.querySelector(s) : document.body)?.innerText ?? "(null)",
        sel || null,
      ),
    );
  },

  async eval(expr) {
    if (!page) return console.log("ERROR: launch first");
    try {
      console.log(JSON.stringify(await page.evaluate(expr)));
    } catch (e) {
      console.log("ERROR:", e.message);
    }
  },

  // Evaluate in the MAIN process (full Electron APIs). The way to
  // sendInputEvent real key events — before-input-event ignores
  // CDP-injected keys, so gesture detectors (double-Shift) are only
  // reachable through this.
  async meval(expr) {
    if (!app) return console.log("ERROR: launch first");
    try {
      const r = await app.evaluate(async (electronApi, e) => {
        const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
        return await new AsyncFunction("electron", `return (${e});`)(electronApi);
      }, expr);
      console.log(JSON.stringify(r));
    } catch (e) {
      console.log("ERROR:", e.message);
    }
  },

  // Evaluate in the floating OVERLAY page (audio player + save-preview
  // cards) — a separate window the chrome-scoped commands cannot reach.
  async oeval(expr) {
    if (!app) return console.log("ERROR: launch first");
    const overlay = app.windows().find((w) => w.url().includes("#save-preview"));
    if (!overlay) return console.log("ERROR: overlay page not found");
    try {
      console.log(JSON.stringify(await overlay.evaluate(expr)));
    } catch (e) {
      console.log("ERROR:", e.message);
    }
  },

  // Evaluate in ANY window, picked by URL substring (first token; the rest
  // of the line is the expression) — the way into a TAB page or the
  // selection-toolbar view, which eval/oeval cannot reach.
  async weval(arg) {
    if (!app) return console.log("ERROR: launch first");
    const space = arg.indexOf(" ");
    if (space === -1) return console.log("ERROR: weval <url-substr> <js>");
    const needle = arg.slice(0, space);
    const expr = arg.slice(space + 1);
    const target = app.windows().find((w) => w.url().includes(needle));
    if (!target) return console.log("ERROR: no window matching", needle);
    try {
      console.log(JSON.stringify(await target.evaluate(expr)));
    } catch (e) {
      console.log("ERROR:", e.message);
    }
  },

  // Which window/webContents has what — Suma spawns one page per
  // WebContentsView (chrome, every tab, suma://files).
  async windows() {
    if (!app) return console.log("ERROR: launch first");
    for (const w of app.windows()) console.log("  page:", w.url());
    const wcs = await app.evaluate(({ webContents }) =>
      webContents
        .getAllWebContents()
        .map((w) => ({ id: w.id, type: w.getType(), url: w.getURL() })),
    );
    for (const w of wcs) console.log(`  wc[${w.id}] ${w.type}: ${w.url}`);
  },

  async sleep(ms) {
    await new Promise((r) => setTimeout(r, Number(ms) || 1000));
    console.log("slept", ms);
  },

  async quit() {
    if (app) await app.close().catch(() => {});
    app = null;
    page = null;
    console.log("quit ok");
  },
  help() {
    console.log("commands:", Object.keys(COMMANDS).join(", "));
  },
};

// Electron steals stdin — read the raw fd so the REPL keeps its input.
const stdin = fs.createReadStream(null, { fd: fs.openSync("/dev/stdin", "r") });
const rl = readline.createInterface({ input: stdin, output: process.stdout, prompt: "driver> " });

rl.on("line", async (line) => {
  const trimmed = line.trim();
  const idx = trimmed.indexOf(" ");
  const cmd = idx < 0 ? trimmed : trimmed.slice(0, idx);
  const rest = idx < 0 ? "" : trimmed.slice(idx + 1);
  if (!cmd) return rl.prompt();
  const fn = COMMANDS[cmd];
  if (!fn) {
    console.log("unknown:", cmd, "— try: help");
    return rl.prompt();
  }
  try {
    await fn(rest);
  } catch (e) {
    console.log("ERROR:", e.message);
  }
  if (cmd === "quit") {
    rl.close();
    process.exit(0);
  }
  rl.prompt();
});
rl.on("close", async () => {
  await COMMANDS.quit();
  process.exit(0);
});

console.log('suma driver — "help" for commands, "launch" to start');
rl.prompt();
