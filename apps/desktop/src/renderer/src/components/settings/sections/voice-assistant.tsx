/**
 * `suma://settings/voice-assistant` — the hands-free assistant ("Suma, …").
 *
 * Everything here is main's state (voice.json, via `voice:settings` /
 * `voice:updateSettings`): the wake-word engine and the agent session run
 * there, so main enforces every knob. No credentials live on this page:
 * the model rides the chat sidebar's gateway key chain (Settings →
 * Assistant / Voice & audio), and the speech voice uses the Bland key from
 * Settings → Voice & audio — the page shows where each credential comes
 * from and links to where it is managed. Browser-tool permissions are
 * deliberately NOT duplicated here either: the voice uses the chat
 * sidebar's tools, so the Assistant page's toggles govern both.
 */

import { useCallback, useEffect, useState } from "react";
import type { TtsVoice } from "../../../../../shared/tts";
import {
  VOICE_MODELS,
  type VoiceSettingsInfo,
  type VoiceSettingsPatch,
  type VoiceStatus,
} from "../../../../../shared/voice";
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
import { Switch } from "../../ui/switch";
import { Block, Group, Page, Row } from "../parts";

function useVoiceSettings(): {
  settings: VoiceSettingsInfo | null;
  status: VoiceStatus | null;
  update: (patch: VoiceSettingsPatch) => void;
} {
  const pushToast = useSumaStore((s) => s.pushToast);
  const [settings, setSettings] = useState<VoiceSettingsInfo | null>(null);
  const [status, setStatus] = useState<VoiceStatus | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const [nextSettings, nextStatus] = await Promise.all([
          window.suma.invoke("voice:settings", undefined),
          window.suma.invoke("voice:status", undefined),
        ]);
        if (live) {
          setSettings(nextSettings);
          setStatus(nextStatus);
        }
      } catch {
        if (live) pushToast("Could not read the voice settings.", "error");
      }
    })();
    const off = window.suma.on("voice:statusChanged", (next) => {
      if (live) setStatus(next);
    });
    return () => {
      live = false;
      off();
    };
  }, [pushToast]);

  const update = useCallback(
    (patch: VoiceSettingsPatch) => {
      void (async () => {
        try {
          setSettings(await window.suma.invoke("voice:updateSettings", patch));
        } catch {
          pushToast("Could not save the voice settings.", "error");
        }
      })();
    },
    [pushToast],
  );

  return { settings, status, update };
}

const KEY_NOTES: Record<VoiceSettingsInfo["keyState"], string> = {
  env: "Using the AI Gateway key from the environment (AI_GATEWAY_API_KEY) — the same model access as the chat sidebar.",
  stored:
    "Using the Vercel AI Gateway key stored under Settings → Voice & audio — the same model access as the chat sidebar.",
  vended:
    "Using models included with your Suma account — the same access as the chat sidebar, with no key stored on this Mac.",
  unset:
    "No model access yet — sign in to your Suma account, add a Vercel AI Gateway key under Settings → Voice & audio, or set AI_GATEWAY_API_KEY.",
};

const TTS_KEY_NOTES: Record<VoiceSettingsInfo["ttsKeyState"], string> = {
  env: "Speech is ready — using the Bland key from the environment.",
  stored: "Speech is ready — using the Bland key from Settings → Voice & audio.",
  unset:
    "Speech needs a Bland API key — add one under Settings → Voice & audio before starting a conversation.",
};

const WAKE_NOTES: Record<VoiceStatus["wakeWord"], string> = {
  off: "Off — start conversations with ⌥Space or the pill in the corner.",
  downloading:
    "Setting up — downloading the on-device listening model (about 15 MB, once).",
  ready: "Ready — listening on this Mac; audio only leaves it during a conversation.",
  unavailable:
    "Unavailable on this machine — ⌥Space and the corner pill still work.",
};

export function VoiceAssistantPage() {
  const { settings, status, update } = useVoiceSettings();
  const openSettings = useSumaStore((s) => s.openSettings);
  const [wakeDraft, setWakeDraft] = useState<string | null>(null);
  const [voices, setVoices] = useState<TtsVoice[]>([]);

  // The account's real Bland voices (built-ins stand in until a key works —
  // main falls back to them on any failure, so this never empties the picker).
  useEffect(() => {
    let live = true;
    void window.suma
      .invoke("tts:voices", { provider: "bland" })
      .then((list) => {
        if (live) setVoices(list);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  const model = settings?.model ?? "";
  const isCurated = VOICE_MODELS.some((entry) => entry.id === model);
  const modelItems = [
    ...VOICE_MODELS.map((entry) => ({ value: entry.id, label: entry.label })),
    ...(isCurated || model === "" ? [] : [{ value: model, label: model }]),
  ];

  const voice = settings?.voice ?? "";
  const voiceItems = [
    ...voices.map((v) => ({ value: v.id, label: v.label })),
    ...(voice === "" || voices.some((v) => v.id === voice)
      ? []
      : [{ value: voice, label: voice }]),
  ];

  const saveWakeWord = (): void => {
    const value = (wakeDraft ?? "").trim();
    if (value === "") return;
    update({ wakeWord: value });
    setWakeDraft(null);
  };

  return (
    <Page
      title="Voice assistant"
      description="Talk to Suma and it talks back — hands-free. Say the wake word (or press ⌥Space anywhere on your Mac) and ask it to search, open tabs, read pages, and act on them for you."
    >
      <Group
        title="Listening"
        note="While armed, listening happens entirely on this Mac. During a conversation — after the wake word or ⌥Space — what you say is transcribed, answered by the assistant model, and spoken back; conversations end themselves after a quiet pause."
      >
        <Row
          label="Enable the voice assistant"
          note="Shows the pill in the top-right corner and asks for microphone access."
        >
          <Switch
            label="Enable the voice assistant"
            checked={settings?.enabled ?? false}
            disabled={settings === null}
            onChange={(next) => update({ enabled: next })}
          />
        </Row>
        <Row
          label="Wake word"
          note={WAKE_NOTES[status?.wakeWord ?? "off"]}
        >
          <Switch
            label="Wake word"
            checked={settings?.wakeWordEnabled ?? true}
            disabled={settings === null || settings.enabled === false}
            onChange={(next) => update({ wakeWordEnabled: next })}
          />
        </Row>
        <Block
          label="Wake phrase"
          note="One to four plain words. Short, distinctive words trigger most reliably."
        >
          <div className="flex items-center gap-2">
            <Input
              spellCheck={false}
              autoComplete="off"
              aria-label="Wake phrase"
              value={wakeDraft ?? settings?.wakeWord ?? ""}
              disabled={settings === null}
              onChange={(e) => setWakeDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                saveWakeWord();
              }}
              className="w-56"
            />
            <Button
              variant="secondary"
              disabled={
                wakeDraft === null ||
                wakeDraft.trim() === "" ||
                wakeDraft.trim() === settings?.wakeWord
              }
              onClick={saveWakeWord}
            >
              Save
            </Button>
          </div>
        </Block>
      </Group>

      <Group title="Model" note={KEY_NOTES[settings?.keyState ?? "unset"]}>
        <Row
          label="Model"
          note="The assistant that hears you and works the browser — the chat sidebar's models, picked for speed."
        >
          <Select
            value={model}
            items={modelItems}
            disabled={settings === null}
            onValueChange={(next: string) => update({ model: next })}
          >
            <SelectTrigger aria-label="Voice model" className="w-[210px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {modelItems.map((entry) => {
                const hint = VOICE_MODELS.find((m) => m.id === entry.value)?.hint;
                return (
                  <SelectItem key={entry.value} value={entry.value}>
                    {hint === undefined ? entry.label : `${entry.label} — ${hint}`}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        </Row>
      </Group>

      <Group title="Speech" note={TTS_KEY_NOTES[settings?.ttsKeyState ?? "unset"]}>
        <Row
          label="Voice"
          note="How the assistant sounds — a Bland voice, spoken in realtime. With a Bland key added, your account's cloned and library voices appear here too."
        >
          <Select
            value={voice}
            items={voiceItems}
            disabled={settings === null}
            onValueChange={(next: string) => update({ voice: next })}
          >
            <SelectTrigger aria-label="Assistant voice" className="w-[210px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {voiceItems.map((entry) => {
                const hint = voices.find((v) => v.id === entry.value)?.hint;
                return (
                  <SelectItem key={entry.value} value={entry.value}>
                    {hint === undefined ? entry.label : `${entry.label} — ${hint}`}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        </Row>
        <Block>
          <Button variant="secondary" onClick={() => void openSettings("voice")}>
            Manage speech keys…
          </Button>
        </Block>
      </Group>

      <Group
        title="What it may do"
        note="The voice assistant uses the same browser tools as the chat sidebar — reading pages, opening tabs, clicking, typing. The Assistant page's capability toggles govern both."
      >
        <Block>
          <Button variant="secondary" onClick={() => void openSettings("assistant")}>
            Manage browser tools…
          </Button>
        </Block>
      </Group>
    </Page>
  );
}
