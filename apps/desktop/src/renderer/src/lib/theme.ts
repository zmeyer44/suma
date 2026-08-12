/**
 * Theme engine for the two-knob palette (styles.css): a base surface color
 * and an accent drive every derived token via OKLCH relative colors. This
 * module owns the runtime side — classifying the base as light or dark,
 * writing the knobs onto <html>, and persisting the choice per machine.
 *
 * Light vs dark is never chosen directly: it falls out of the base color's
 * relative luminance, and `data-theme` flips the CSS ladder (light surfaces
 * need darker edges, dark text, and ink washes instead of white ones).
 *
 * Until someone picks a theme there is nothing stored, and the chrome follows
 * this Mac's own appearance setting — including live, when it is changed while
 * Suma is running. Picking any theme (or a preset) ends that: an explicit
 * choice is stored and outranks the system. The Appearance panel's "Follow
 * system" hands the choice back.
 */

export interface ThemeColors {
  /** #rrggbb neutral surface the whole ladder derives from. */
  base: string;
  /** #rrggbb accent for actions, focus, and highlights. */
  accent: string;
}

export interface ThemePreset extends ThemeColors {
  id: string;
  name: string;
}

/**
 * Suma's royal blue — `oklch(0.517 0.192 264.5)`, the one accent the marketing
 * site is built around (`apps/www/src/app/globals.css`, `--royal`).
 *
 * Both defaults below are this hue and chroma. Only the LIGHTNESS differs, and
 * only because it has to: the accent is a fill behind `--color-bg` text on the
 * primary button and a text color on the panel everywhere else, so it has to
 * hold contrast against opposite ends of the surface ladder. Royal at its own
 * lightness reads 4.80:1 / 5.59:1 on the light ladder — comfortably AA — but
 * only 3.44:1 / 3.24:1 on the dark one, which is under AA for the 10–12px
 * accent text the chrome is full of (badges, soft buttons, links).
 *
 * So light takes royal exactly, and dark takes royal lifted to L 0.66, which
 * is the same color the dark chrome already shipped (#5b8cff was royal's hue
 * to within 0.1°) restated as a derivation instead of a coincidence. Chroma is
 * held just under royal's 0.192 because sRGB has no room for the full amount
 * at that lightness — 0.185 is the gamut edge.
 */

/** What a Mac set to dark gets: royal at L 0.66 — 6.26:1 / 5.90:1. */
export const DEFAULT_DARK_THEME: ThemeColors = { base: "#0f1115", accent: "#588bff" };
/** What a Mac set to light gets — the Paper preset. Royal exactly. */
export const DEFAULT_LIGHT_THEME: ThemeColors = { base: "#fafaf8", accent: "#2e5cd4" };

export const THEME_PRESETS: readonly ThemePreset[] = [
  { id: "suma", name: "Suma", ...DEFAULT_DARK_THEME },
  { id: "abyss", name: "Abyss", base: "#0c1210", accent: "#45d19a" },
  { id: "dusk", name: "Dusk", base: "#141020", accent: "#a78bfa" },
  { id: "ember", name: "Ember", base: "#171009", accent: "#f59e5b" },
  { id: "rosewood", name: "Rosewood", base: "#180d12", accent: "#f472a0" },
  // Light bases name the FOREGROUND surface (card/tab/modal face), so they
  // sit near white — the ladder steps down from them. See styles.css.
  { id: "paper", name: "Paper", ...DEFAULT_LIGHT_THEME },
  { id: "fog", name: "Fog", base: "#f8fafc", accent: "#0f8a7a" },
];

const HEX_RE = /^#[0-9a-f]{6}$/i;

export function isValidHex(value: string): boolean {
  return HEX_RE.test(value);
}

/** Normalize user input ("5B8CFF", "#5b8cff") to #rrggbb, or null. */
export function normalizeHex(value: string): string | null {
  const v = value.trim().toLowerCase();
  const withHash = v.startsWith("#") ? v : `#${v}`;
  return HEX_RE.test(withHash) ? withHash : null;
}

/** WCAG relative luminance of a #rrggbb color, 0 (black) → 1 (white). */
export function relativeLuminance(hex: string): number {
  const channel = (i: number): number => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/**
 * A base is "light" when it is bright enough to need dark text — roughly a
 * mid grey and up. Everything below reads as a dark theme with the normal
 * lighter-than-base surface ladder.
 */
export function isLightBase(base: string): boolean {
  return relativeLuminance(base) >= 0.4;
}

const STORAGE_KEY = "suma:theme";
const TRANSLUCENT_KEY = "suma:translucent";

/**
 * Translucency is a macOS-only material (main asks AppKit for the vibrancy
 * layer; there is no equivalent elsewhere), so the control is hidden rather
 * than shown-and-dead on other platforms.
 */
export function isTranslucencySupported(): boolean {
  return navigator.userAgent.includes("Macintosh");
}

export function getStoredTranslucency(): boolean {
  try {
    return localStorage.getItem(TRANSLUCENT_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Flip the chrome between opaque and translucent. Two halves have to agree:
 * `data-translucent` on <html> switches the chrome surfaces to their
 * alpha-carrying variants (styles.css), and main puts the window's vibrancy
 * layer behind them so there is something to blur through.
 */
export function applyTranslucency(enabled: boolean): void {
  const on = enabled && isTranslucencySupported();
  document.documentElement.dataset["translucent"] = on ? "on" : "off";
  // Guarded: jsdom tests have no preload bridge.
  if (window.suma) {
    void window.suma.invoke("ui:setTranslucency", { enabled: on });
  }
  try {
    localStorage.setItem(TRANSLUCENT_KEY, on ? "1" : "0");
  } catch {
    // Persistence is best-effort; the applied mode still works this session.
  }
}

/** Exported so UI that displays the active palette can re-read on an OS flip. */
export const DARK_QUERY = "(prefers-color-scheme: dark)";

/**
 * Does this Mac ask for a dark UI? Truthful only while main leaves
 * nativeTheme on "system" — which it does at boot and whenever no theme is
 * stored, i.e. exactly when this is consulted. After an override the honest
 * answer comes back from main instead (see `followSystemTheme`).
 */
export function prefersDarkScheme(): boolean {
  // jsdom has no matchMedia; dark is the palette Suma shipped with.
  if (typeof window.matchMedia !== "function") return true;
  return window.matchMedia(DARK_QUERY).matches;
}

/** The default palette for this Mac's current appearance setting. */
export function systemTheme(): ThemeColors {
  return prefersDarkScheme() ? DEFAULT_DARK_THEME : DEFAULT_LIGHT_THEME;
}

/**
 * An explicitly chosen theme, or null while the chrome follows the system.
 *
 * `chosen` separates the two: earlier builds had no follow mode and re-persisted
 * the default palette on every launch, so a stored copy of the dark default is
 * not evidence that anyone picked it — every install that ever ran one of those
 * builds has one. Those entries are read as "no choice" so the Mac's setting
 * takes over; a stored theme that is anything else was picked deliberately and
 * is kept. Choosing the dark default from the Appearance panel today writes
 * `chosen`, which pins it for real.
 */
export function readStoredTheme(): ThemeColors | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Partial<ThemeColors> & { chosen?: boolean };
    if (typeof parsed.base === "string" && isValidHex(parsed.base) &&
        typeof parsed.accent === "string" && isValidHex(parsed.accent)) {
      const theme = { base: parsed.base, accent: parsed.accent };
      const legacyDefault =
        theme.base === DEFAULT_DARK_THEME.base && theme.accent === DEFAULT_DARK_THEME.accent;
      if (parsed.chosen !== true && legacyDefault) return null;
      return theme;
    }
  } catch {
    // Corrupt storage reads as no choice at all.
  }
  return null;
}

export function isFollowingSystemTheme(): boolean {
  return readStoredTheme() === null;
}

/** The palette in force: an explicit choice if there is one, else the Mac's. */
export function getActiveTheme(): ThemeColors {
  return readStoredTheme() ?? systemTheme();
}

/** Write the knobs onto <html>; the CSS ladder does the rest. */
function paintTheme(theme: ThemeColors): void {
  const root = document.documentElement;
  root.style.setProperty("--color-base", theme.base);
  root.style.setProperty("--color-accent", theme.accent);
  root.dataset["theme"] = isLightBase(theme.base) ? "light" : "dark";
}

/**
 * Tell main where the scheme comes from. It mirrors light/dark into Electron's
 * nativeTheme so tab pages report the matching prefers-color-scheme and render
 * their own UI to match the chrome; "system" puts that back under the Mac's
 * control. Resolves to which way it landed. (Guarded: jsdom tests have no
 * preload bridge.)
 */
async function assertScheme(scheme: "light" | "dark" | "system"): Promise<boolean> {
  if (window.suma) {
    const { dark } = await window.suma.invoke("ui:setColorScheme", { scheme });
    return dark;
  }
  // No bridge to mirror into (jsdom tests): answer from what is knowable here.
  return scheme === "system" ? prefersDarkScheme() : scheme === "dark";
}

/** Apply a chosen theme and remember it — an explicit choice outranks the OS. */
export function applyTheme(theme: ThemeColors): void {
  paintTheme(theme);
  void assertScheme(isLightBase(theme.base) ? "light" : "dark");
  try {
    // `chosen` marks this as a real decision — see readStoredTheme.
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...theme, chosen: true }));
  } catch {
    // Persistence is best-effort; the applied theme still works this session.
  }
}

/**
 * Drop any explicit choice and go back to following this Mac. Returns the
 * palette it landed on.
 *
 * The scheme has to come from main rather than from matchMedia: nativeTheme is
 * still forcing the scheme being dropped at the moment this is called, so the
 * renderer's own media query would just echo the override back.
 */
export async function followSystemTheme(): Promise<ThemeColors> {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to clear if storage is unavailable.
  }
  const theme = (await assertScheme("system")) ? DEFAULT_DARK_THEME : DEFAULT_LIGHT_THEME;
  paintTheme(theme);
  return theme;
}

/** Drop the customized theme so the next launch paints the default (§8.2
 *  sign-out resets appearance along with everything else). */
export function clearStoredTheme(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(TRANSLUCENT_KEY);
  } catch {
    // Nothing to clear if storage is unavailable.
  }
}

/**
 * Repaint on OS appearance changes, for as long as nothing is stored. The
 * listener is permanent but re-checks storage every time: once a theme is
 * picked it goes quiet, and it wakes up again if that choice is dropped.
 */
function watchSystemScheme(): void {
  if (typeof window.matchMedia !== "function") return;
  window.matchMedia(DARK_QUERY).addEventListener("change", (e) => {
    if (!isFollowingSystemTheme()) return;
    paintTheme(e.matches ? DEFAULT_DARK_THEME : DEFAULT_LIGHT_THEME);
  });
}

/**
 * Paint-only init for pages that are NOT the chrome (the save-preview
 * overlay): same palette and surface styling, but no ui:setColorScheme /
 * ui:setTranslucency invokes — main mirrors nativeTheme once, for the whole
 * app, on the chrome's say-so, and those channels reject other senders.
 */
export function initThemePaintOnly(): void {
  paintTheme(getActiveTheme());
  const on = getStoredTranslucency() && isTranslucencySupported();
  document.documentElement.dataset["translucent"] = on ? "on" : "off";
  watchSystemScheme();
}

/** Apply the stored appearance before first paint (called from the entry module). */
export function initTheme(): void {
  const stored = readStoredTheme();
  if (stored !== null) {
    applyTheme(stored);
  } else {
    // Nothing chosen: follow the Mac. main has not overridden nativeTheme this
    // early, so matchMedia is already the truth and the palette can be painted
    // now rather than a round trip later — no flash of the wrong scheme.
    paintTheme(systemTheme());
    void assertScheme("system");
  }
  // Always asserted, on as well as off: main's window keeps whatever vibrancy
  // state it was last left in across a renderer reload (§8.2 sign-out), so
  // "off" has to be said out loud to undo it.
  applyTranslucency(getStoredTranslucency());
  watchSystemScheme();
}
