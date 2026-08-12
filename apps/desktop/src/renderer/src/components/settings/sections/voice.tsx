/**
 * `suma://settings/voice` — who reads text aloud, and how it plays back.
 *
 * The page is split along the line the implementation is split along, because
 * the two halves have genuinely different consequences:
 *
 *   - READING VOICE is main's state (provider, voice, keys). It is written
 *     through `tts:updateSettings` and lands in tts.json on this Mac. An API key
 *     travels in exactly one direction: the field below sends it, and nothing
 *     ever reads it back — the page is told only whether a key EXISTS, which is
 *     why a stored key shows as "Stored on this Mac" and not as dots.
 *   - PLAYBACK is the audio element's state (speed, volume), applied live to
 *     whatever is playing and remembered in localStorage like the theme.
 *
 * Voice lists are asked for rather than shipped: `say -v ?` is the truth about
 * which voices THIS Mac has, and a hardcoded list would be wrong on any Mac
 * with a downloaded voice.
 */

import { useCallback, useEffect, useState } from "react";
import {
  TTS_PROVIDERS,
  TTS_PREVIEW_TEXT,
  TTS_SPEED_MAX,
  TTS_SPEED_MIN,
  TTS_SPEED_STEP,
  resolvedModel,
  speedLabel,
  staticVoices,
  ttsProviderInfo,
  type TtsKeyProvider,
  type TtsKeyState,
  type TtsProviderId,
  type TtsSettingsInfo,
  type TtsSettingsPatch,
  type TtsVoice,
} from "../../../../../shared/tts";
import { useAudioStore } from "../../../lib/audio";
import { useSumaStore } from "../../../store";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../ui/select";
import { Slider } from "../../ui/slider";
import { Textarea } from "../../ui/textarea";
import { Block, Group, Page, Row } from "../parts";

/** The provider list, in the `{ value, label }` shape Select reads for its trigger. */
const PROVIDER_ITEMS = TTS_PROVIDERS.map((entry) => ({
  value: entry.id,
  label: entry.label,
}));

/**
 * The page's copy of main's TTS settings. Loaded once, then updated from the
 * reply to every write — main returns the STORED state, so a rejected value
 * (an unknown provider) shows as what was really saved rather than as what was
 * typed.
 */
function useTtsSettings(): {
  settings: TtsSettingsInfo | null;
  update: (patch: TtsSettingsPatch) => void;
} {
  const pushToast = useSumaStore((s) => s.pushToast);
  const [settings, setSettings] = useState<TtsSettingsInfo | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const next = await window.suma.invoke("tts:settings", undefined);
        if (live) setSettings(next);
      } catch {
        if (live) pushToast("Could not read the voice settings.", "error");
      }
    })();
    return () => {
      live = false;
    };
  }, [pushToast]);

  const update = useCallback(
    (patch: TtsSettingsPatch) => {
      void (async () => {
        try {
          setSettings(await window.suma.invoke("tts:updateSettings", patch));
        } catch {
          pushToast("Could not save the voice settings.", "error");
        }
      })();
    },
    [pushToast],
  );

  return { settings, update };
}

/**
 * The chosen provider's voices. Shipped for the providers whose catalog is
 * fixed; asked of main for the two that are not — `say -v ?` is the truth about
 * THIS Mac, and a Bland account's voices include whatever it has cloned. The
 * shipped list shows first for those, so the picker is never briefly empty
 * while main is off fetching.
 */
function useVoices(provider: TtsProviderId | undefined): TtsVoice[] {
  const [voices, setVoices] = useState<TtsVoice[]>([]);

  useEffect(() => {
    if (provider === undefined) return;
    setVoices([...staticVoices(provider)]);
    if (ttsProviderInfo(provider).liveVoices !== true) return;
    let live = true;
    void (async () => {
      try {
        const next = await window.suma.invoke("tts:voices", { provider });
        if (live) setVoices(next);
      } catch {
        // Keep whatever was shipped rather than emptying a working picker.
      }
    })();
    return () => {
      live = false;
    };
  }, [provider]);

  return voices;
}

const KEY_NOTE: Record<TtsKeyProvider, string> = {
  openai: "Used for OpenAI speech only. Stored on this Mac, never synced.",
  elevenlabs: "Used for ElevenLabs speech only. Stored on this Mac, never synced.",
  vercel:
    "Your AI Gateway key, so speech is billed and metered with the rest of your model traffic. Stored on this Mac, never synced.",
  bland:
    "Used for Bland speech only, and to list the voices on your account. Stored on this Mac, never synced.",
};

/** Named so the page can tell the user which variable to set instead. */
const KEY_ENV_HINT: Record<TtsKeyProvider, string> = {
  openai: "OPENAI_API_KEY",
  elevenlabs: "ELEVENLABS_API_KEY",
  vercel: "VERCEL_GATEWAY_API_KEY",
  bland: "BLAND_API_KEY",
};

/**
 * One provider's key. A stored key is never redisplayed — the field is empty
 * with a "Replace" placeholder, because the only useful operations on a
 * credential you cannot read are "set a new one" and "remove it".
 */
function ApiKeyBlock({
  provider,
  state,
  onSave,
}: {
  provider: TtsKeyProvider;
  state: TtsKeyState;
  onSave: (key: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const label = ttsProviderInfo(provider).label;
  const status =
    state === "env"
      ? `Supplied by ${KEY_ENV_HINT[provider]} — the environment wins over anything typed here.`
      : state === "stored"
        ? "Stored on this Mac."
        : `No key yet. ${KEY_ENV_HINT[provider]} works too, if you would rather not paste one.`;

  return (
    <Block label={`${label} API key`} note={`${KEY_NOTE[provider]} ${status}`}>
      <div className="flex items-center gap-2">
        <Input
          type="password"
          spellCheck={false}
          autoComplete="off"
          aria-label={`${label} API key`}
          placeholder={state === "unset" ? "Paste a key" : "Replace the stored key"}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            if (draft.trim() === "") return;
            onSave(draft.trim());
            setDraft("");
          }}
          className="flex-1 font-mono placeholder:font-sans"
        />
        <Button
          variant="secondary"
          disabled={draft.trim() === ""}
          onClick={() => {
            onSave(draft.trim());
            setDraft("");
          }}
        >
          Save
        </Button>
        {state === "stored" ? (
          <Button variant="danger" onClick={() => onSave("")}>
            Remove
          </Button>
        ) : null}
      </div>
    </Block>
  );
}

/** Speed and volume: the audio element's own state, applied as you move them. */
function PlaybackGroup() {
  const rate = useAudioStore((s) => s.rate);
  const volume = useAudioStore((s) => s.volume);
  const muted = useAudioStore((s) => s.muted);
  const setRate = useAudioStore((s) => s.setRate);
  const setVolume = useAudioStore((s) => s.setVolume);
  const setMuted = useAudioStore((s) => s.setMuted);

  return (
    <Group
      title="Playback"
      note="Applies to whatever is playing now, and to the next thing that plays. Remembered on this Mac."
    >
      <Row
        label="Speed"
        note="The dock's speed chip changes this too — this is the value it starts from."
      >
        <span className="flex items-center gap-2">
          <Slider
            min={TTS_SPEED_MIN}
            max={TTS_SPEED_MAX}
            step={TTS_SPEED_STEP}
            value={rate}
            aria-label="Playback speed"
            onValueChange={(next) => setRate(next)}
            className="w-[120px]"
          />
          <span className="w-9 font-mono text-[11.5px] tabular-nums text-muted">
            {speedLabel(rate)}
          </span>
        </span>
      </Row>
      <Row label="Volume" note="Independent of the system volume.">
        <span className="flex items-center gap-2">
          <Slider
            min={0}
            max={1}
            step={0.05}
            value={muted ? 0 : volume}
            aria-label="Volume"
            onValueChange={(next) => {
              if (muted && next > 0) setMuted(false);
              setVolume(next);
            }}
            className="w-[120px]"
          />
          <span className="w-9 font-mono text-[11.5px] tabular-nums text-muted">
            {`${String(Math.round((muted ? 0 : volume) * 100))}%`}
          </span>
        </span>
      </Row>
    </Group>
  );
}

export function VoicePage() {
  const { settings, update } = useTtsSettings();
  const provider = settings?.provider;
  const voices = useVoices(provider);
  const play = useAudioStore((s) => s.play);
  const [preview, setPreview] = useState(TTS_PREVIEW_TEXT);

  const selectedVoice = provider === undefined ? "" : (settings?.voices[provider] ?? "");
  const info = provider === undefined ? null : ttsProviderInfo(provider);
  const selectedModel =
    provider === undefined || settings === null
      ? null
      : resolvedModel(provider, settings.models);

  /*
   * The trigger shows the bare voice name; the list below adds the hint, which
   * is more than a 190px trigger can hold. `system` keeps its empty entry,
   * because an unset voice there means "whatever `say` defaults to" rather
   * than "nothing picked".
   */
  const voiceItems = [
    ...(provider === "system" ? [{ value: "", label: "System default" }] : []),
    ...voices.map((voice) => ({ value: voice.id, label: voice.label })),
  ];

  return (
    <Page
      title="Voice & audio"
      description="Pick who reads text aloud. Playback is app-wide: it keeps going while you switch tabs, browse, or close the page it came from."
    >
      <Group title="Reading voice" note={info?.blurb}>
        <Row
          label="Provider"
          note={
            settings?.systemVoiceAvailable === false
              ? "The macOS voice needs macOS — on this platform, pick a remote provider."
              : "The macOS voice is offline and free; the remote providers sound better and send the text to their API."
          }
        >
          <Select
            value={provider ?? ""}
            items={PROVIDER_ITEMS}
            disabled={settings === null}
            onValueChange={(next: string) => update({ provider: next as TtsProviderId })}
          >
            <SelectTrigger aria-label="Speech provider" className="w-[150px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TTS_PROVIDERS.map((entry) => (
                <SelectItem
                  key={entry.id}
                  value={entry.id}
                  disabled={entry.id === "system" && settings?.systemVoiceAvailable === false}
                >
                  {entry.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Row>

        {/* Only the gateway and Bland offer more than one speech model, so this
            row exists only when there is a real choice to make. */}
        {info?.models === undefined ? null : (
          <Row
            label="Speech model"
            note={
              provider === "bland"
                ? "Which generation synthesizes the text. A cloned voice sounds closest on the model it was made against."
                : "Which model the gateway routes to. Vercel's text-to-speech supports OpenAI speech models today."
            }
          >
            <Select
              value={selectedModel ?? ""}
              items={info.models.map((model) => ({ value: model.id, label: model.label }))}
              disabled={settings === null}
              onValueChange={(next: string) => {
                if (provider === undefined) return;
                update({ models: { [provider]: next } });
              }}
            >
              <SelectTrigger aria-label="Speech model" className="w-[170px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {info.models.map((model) => (
                  <SelectItem key={model.id} value={model.id}>
                    {model.hint === undefined
                      ? model.label
                      : `${model.label} — ${model.hint}`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Row>
        )}

        <Row
          label="Voice"
          note={
            provider === "system"
              ? "Every voice installed on this Mac. Add more in System Settings → Accessibility → Spoken Content."
              : provider === "bland"
                ? "Your account's voices, clones included — the three built-ins until a key below unlocks the rest."
                : (info?.model ?? undefined)
          }
        >
          <span className="flex items-center gap-2">
            <Select
              value={selectedVoice}
              items={voiceItems}
              disabled={settings === null || provider === undefined}
              onValueChange={(next: string) => {
                if (provider === undefined) return;
                update({ voices: { [provider]: next } });
              }}
            >
              <SelectTrigger aria-label="Voice" className="w-[190px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {provider === "system" ? (
                  <SelectItem value="">System default</SelectItem>
                ) : null}
                {voices.map((voice) => (
                  <SelectItem key={voice.id} value={voice.id}>
                    {voice.hint === undefined ? voice.label : `${voice.label} — ${voice.hint}`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {/* Previews go through the REAL player, so what you hear is exactly
                what a read-aloud will sound like — same dock, same speed. */}
            <Button
              variant="secondary"
              disabled={provider === undefined}
              onClick={() => {
                if (provider === undefined) return;
                play({
                  id: `voice-preview-${provider}-${selectedVoice}`,
                  title: "Voice preview",
                  origin: "Settings",
                  source: {
                    kind: "tts",
                    text: preview.trim() === "" ? TTS_PREVIEW_TEXT : preview,
                    provider,
                    voice: selectedVoice,
                  },
                });
              }}
            >
              Preview
            </Button>
          </span>
        </Row>

        <Block
          label="Preview text"
          note="What the Preview button reads. Handy for hearing how a voice says a name you care about."
        >
          <Textarea
            rows={2}
            spellCheck={false}
            aria-label="Preview text"
            value={preview}
            onChange={(e) => setPreview(e.target.value)}
            className="w-full resize-y"
          />
        </Block>
      </Group>

      <Group
        title="API keys"
        note="Only the selected provider's key is ever used. Keys stay on this Mac — they are not synced to your other devices, and they are erased when you sign out."
      >
        <ApiKeyBlock
          provider="openai"
          state={settings?.keys.openai ?? "unset"}
          onSave={(key) => update({ apiKeys: { openai: key } })}
        />
        <ApiKeyBlock
          provider="elevenlabs"
          state={settings?.keys.elevenlabs ?? "unset"}
          onSave={(key) => update({ apiKeys: { elevenlabs: key } })}
        />
        <ApiKeyBlock
          provider="vercel"
          state={settings?.keys.vercel ?? "unset"}
          onSave={(key) => update({ apiKeys: { vercel: key } })}
        />
        <ApiKeyBlock
          provider="bland"
          state={settings?.keys.bland ?? "unset"}
          onSave={(key) => update({ apiKeys: { bland: key } })}
        />
      </Group>

      <PlaybackGroup />
    </Page>
  );
}
