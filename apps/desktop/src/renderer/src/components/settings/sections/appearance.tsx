/**
 * `suma://settings/appearance` — pick a base surface color and an accent, or
 * a preset, and the two-knob palette (styles.css) re-derives the whole chrome
 * live. Light vs dark is CLASSIFIED from the base color, never chosen
 * directly: a theme is one surface plus one accent, and everything else is a
 * consequence of them.
 *
 * Moved here from the standalone Appearance modal it used to open on top of
 * the Settings modal — a dialog over a dialog to change two colors.
 */

import { useEffect, useState } from "react";
import {
  applyTheme,
  applyTranslucency,
  DARK_QUERY,
  followSystemTheme,
  getActiveTheme,
  getStoredTranslucency,
  isFollowingSystemTheme,
  isLightBase,
  isTranslucencySupported,
  normalizeHex,
  THEME_PRESETS,
  type ThemeColors,
  type ThemePreset,
} from "../../../lib/theme";
import { Moon, Sun } from "lucide-react";
import { cn } from "../../../lib/cn";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Switch } from "../../ui/switch";
import { Block, Group, Page, Row } from "../parts";

/**
 * A miniature of the real chrome, painted entirely with live tokens — it
 * re-derives with every color change, so it doubles as the fine-print proof
 * that the whole ladder (strip, tab, edges, text, accent) follows the knobs.
 *
 * In translucent mode a stand-in "wallpaper" is laid behind it: the strip and
 * tab tokens already carry their alpha, so the preview thins out exactly as
 * the window does. It shows the tint, not the blur — that part is AppKit's.
 */
function ThemePreview({ translucent }: { translucent: boolean }) {
  return (
    <div
      aria-hidden="true"
      className="relative overflow-hidden rounded-xl border border-chrome-edge shadow-pop"
    >
      {translucent ? (
        <span
          className="absolute inset-0"
          style={{
            background:
              "linear-gradient(120deg, var(--color-accent) 0%, oklch(from var(--color-accent) calc(l + 0.12) calc(c * 0.7) calc(h + 110)) 55%, oklch(from var(--color-accent) calc(l - 0.1) c calc(h - 60)) 100%)",
          }}
        />
      ) : null}
      <div className="relative flex h-9 items-end bg-[linear-gradient(180deg,var(--color-strip-deep)_0%,var(--color-strip)_100%)] px-2.5">
        <span className="absolute top-2.5 left-2.5 flex gap-1">
          <span className="size-1.5 rounded-full bg-ink/15" />
          <span className="size-1.5 rounded-full bg-ink/15" />
          <span className="size-1.5 rounded-full bg-ink/15" />
        </span>
        {/* bg-tab-face, like the real tab: this sits ON the mini strip, so it
            needs the alpha that composites with it rather than the raw one. */}
        <div className="relative z-10 -mb-px ml-10 h-6 w-26 rounded-t-[7px] border border-b-0 border-chrome-edge bg-tab-face px-2 pt-[7px]">
          <span className="block h-1.5 w-14 rounded-full bg-ink/25" />
        </div>
        <div className="mb-1 ml-1.5 flex h-4.5 w-16 items-center rounded-md bg-ink/6 px-1.5">
          <span className="block h-1 w-9 rounded-full bg-ink/15" />
        </div>
        <span className="mb-1.5 ml-auto size-3.5 rounded-full bg-accent/85" />
      </div>
      {/* `relative` on the opaque half too: the wallpaper is positioned, so a
          static sibling would paint under it. */}
      <div className="relative h-px bg-chrome-edge" />
      <div className="relative flex flex-col gap-2 bg-panel px-3 py-3">
        <div className="flex items-center gap-2">
          <span className="size-5 rounded-md bg-ink/10" />
          <span className="h-2 w-24 rounded-full bg-ink/15" />
          <span className="h-2 w-14 rounded-full bg-ink/8" />
          <span className="ml-auto grid h-5 place-items-center rounded-md bg-accent px-2 text-[9px] font-semibold text-bg">
            Button
          </span>
        </div>
        <span className="block h-2 w-40 rounded-full bg-ink/10" />
        <span className="block h-2 w-31 rounded-full bg-ink/6" />
      </div>
    </div>
  );
}

function PresetCard({
  preset,
  selected,
  onSelect,
}: {
  preset: ThemePreset;
  selected: boolean;
  onSelect: () => void;
}) {
  const light = isLightBase(preset.base);
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      title={`${preset.name} · ${light ? "light" : "dark"}`}
      className={cn(
        "group flex cursor-pointer flex-col items-center gap-1.5 rounded-xl border p-2 transition-colors",
        selected
          ? "border-accent/60 bg-accent/8"
          : "border-hairline bg-ink/3 hover:border-ink/20 hover:bg-ink/6",
      )}
    >
      <span
        className="relative h-9 w-full overflow-hidden rounded-lg border border-ink/10"
        style={{ background: preset.base }}
      >
        <span
          className="absolute bottom-1.5 left-1.5 size-3 rounded-full shadow-[0_1px_2px_rgb(0_0_0/0.3)]"
          style={{ background: preset.accent }}
        />
        <span
          className="absolute top-1 right-1"
          style={{ color: light ? "rgb(0 0 0 / 0.4)" : "rgb(255 255 255 / 0.4)" }}
        >
          {light ? (
            <Sun className="size-2.5" aria-hidden="true" />
          ) : (
            <Moon className="size-2.5" aria-hidden="true" />
          )}
        </span>
      </span>
      <span className={cn("text-[10.5px]", selected ? "font-medium text-text" : "text-muted")}>
        {preset.name}
      </span>
    </button>
  );
}

function ColorRow({
  label,
  note,
  value,
  onChange,
}: {
  label: string;
  note: string;
  value: string;
  onChange: (hex: string) => void;
}) {
  // Free-typing draft; only valid hex commits, blur snaps back to canonical.
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <Row label={label} note={note}>
      <span className="flex items-center gap-1.5">
        <Input
          type="text"
          spellCheck={false}
          autoComplete="off"
          aria-label={`${label} hex value`}
          value={draft ?? value}
          onChange={(e) => {
            setDraft(e.target.value);
            const hex = normalizeHex(e.target.value);
            if (hex !== null) onChange(hex);
          }}
          onBlur={() => setDraft(null)}
          className="w-20 font-mono"
        />
        {/* The one control that stays native: `type="color"` IS the macOS color
            panel, and there is no component that can stand in for it. It is
            invisible behind the swatch it fills, so the OS widget's own look
            never reaches the page. */}
        <label
          className="relative block size-7 cursor-pointer overflow-hidden rounded-lg border border-ink/15"
          style={{ background: value }}
        >
          <input
            type="color"
            aria-label={`${label} picker`}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className="absolute inset-0 size-full cursor-pointer opacity-0"
          />
        </label>
      </span>
    </Row>
  );
}

export function AppearancePage() {
  const [theme, setThemeState] = useState<ThemeColors>(getActiveTheme);
  /** No theme stored — the chrome is tracking this Mac's appearance setting. */
  const [following, setFollowing] = useState(isFollowingSystemTheme);
  const [translucent, setTranslucentState] = useState(getStoredTranslucency);
  const canBeTranslucent = isTranslucencySupported();

  /**
   * A page stays mounted across an OS appearance flip — the modal this
   * replaced could re-sync on open, because opening was the only way to see
   * it. lib/theme.ts repaints the chrome for the flip but tells no component,
   * so without this the swatches and hex fields keep showing the palette that
   * was in force at mount while the window around them says otherwise.
   *
   * A no-op once a theme is picked: `getActiveTheme` returns the stored choice
   * regardless of what the Mac is doing.
   */
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(DARK_QUERY);
    const resync = (): void => {
      setThemeState(getActiveTheme());
      setFollowing(isFollowingSystemTheme());
    };
    query.addEventListener("change", resync);
    return () => query.removeEventListener("change", resync);
  }, []);

  const set = (next: ThemeColors): void => {
    setThemeState(next);
    setFollowing(false);
    applyTheme(next);
  };

  const follow = (): void => {
    void followSystemTheme().then((next) => {
      setThemeState(next);
      setFollowing(true);
    });
  };

  const setTranslucent = (next: boolean): void => {
    setTranslucentState(next);
    applyTranslucency(next);
  };

  const light = isLightBase(theme.base);

  return (
    <Page
      title="Appearance"
      description="Two knobs — a base surface and an accent — derive every surface, edge, and text tone. Applies instantly, on this Mac only."
    >
      <ThemePreview translucent={translucent} />

      <Group title="Presets">
        <Block>
          <div className="grid grid-cols-4 gap-2 @max-md:grid-cols-2">
            {THEME_PRESETS.map((preset) => (
              <PresetCard
                key={preset.id}
                preset={preset}
                selected={preset.base === theme.base && preset.accent === theme.accent}
                onSelect={() => set({ base: preset.base, accent: preset.accent })}
              />
            ))}
          </div>
        </Block>
        <Row
          label="Follow this Mac's appearance"
          note={
            following
              ? "On — the chrome flips with macOS between light and dark."
              : "Hand the choice back to macOS and drop the colors below."
          }
        >
          <Button
            variant="secondary"
            disabled={following && !translucent}
            onClick={() => {
              follow();
              setTranslucent(false);
            }}
          >
            {following ? "Following" : "Follow system"}
          </Button>
        </Row>
      </Group>

      <Group title="Custom">
        <ColorRow
          label="Base color"
          note={`Every surface, edge, and text tone derives from it — currently a ${
            light ? "light" : "dark"
          } theme, classified from this color's luminance.`}
          value={theme.base}
          onChange={(base) => set({ ...theme, base })}
        />
        <ColorRow
          label="Accent color"
          note="Buttons, focus rings, badges, and highlights."
          value={theme.accent}
          onChange={(accent) => set({ ...theme, accent })}
        />
      </Group>

      {canBeTranslucent ? (
        <Group title="Window">
          <Row
            label="Translucent chrome"
            note="The tab strip thins out and macOS blurs whatever sits behind the window. Page content stays opaque — the blur belongs to the chrome around it."
          >
            <Switch
              checked={translucent}
              onChange={setTranslucent}
              label="Translucent chrome"
            />
          </Row>
        </Group>
      ) : null}
    </Page>
  );
}
