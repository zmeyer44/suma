/**
 * `suma://settings/voice-assistant` — the hands-free assistant ("Suma, …").
 *
 * Everything here is main's state (voice.json, via `voice:settings` /
 * `voice:updateSettings`): the wake-word engine and the Gemini Live session
 * run there, so main enforces every knob. The Gemini key follows the TTS
 * pattern — sent once, never read back, the page shows only where the
 * credential came from. Browser-tool permissions are deliberately NOT
 * duplicated here: the voice uses the chat sidebar's tools, so the
 * Assistant page's toggles govern both, and this page links there.
 */

import { useCallback, useEffect, useState } from "react";
import {
  VOICE_MODELS,
  VOICE_VOICES,
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
  env: "Using the Gemini key from the environment (GEMINI_API_KEY).",
  stored: "Using the Gemini key stored on this Mac.",
  vended:
    "Using voice included with your Suma account — each conversation gets its own short-lived key, and none is stored on this Mac. Add your own Gemini key below to use it instead.",
  unset:
    "No voice access yet — sign in to your Suma account, paste a Gemini key below (aistudio.google.com), or set GEMINI_API_KEY.",
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
  const [keyDraft, setKeyDraft] = useState("");

  const model = settings?.model ?? "";
  const isCurated = VOICE_MODELS.some((entry) => entry.id === model);
  const modelItems = [
    ...VOICE_MODELS.map((entry) => ({ value: entry.id, label: entry.label })),
    ...(isCurated || model === "" ? [] : [{ value: model, label: model }]),
  ];

  const saveWakeWord = (): void => {
    const value = (wakeDraft ?? "").trim();
    if (value === "") return;
    update({ wakeWord: value });
    setWakeDraft(null);
  };

  const saveKey = (value: string): void => {
    update({ apiKey: value });
    setKeyDraft("");
  };

  return (
    <Page
      title="Voice assistant"
      description="Talk to Suma and it talks back — hands-free. Say the wake word (or press ⌥Space anywhere on your Mac) and ask it to search, open tabs, read pages, and act on them for you."
    >
      <Group
        title="Listening"
        note="While armed, listening happens entirely on this Mac. Audio is only sent to Google's Gemini Live API during a conversation — after the wake word or ⌥Space — and conversations end themselves after a quiet pause."
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

      <Group title="Model & voice" note={KEY_NOTES[settings?.keyState ?? "unset"]}>
        <Row
          label="Model"
          note="A Gemini Live model — the one connection that listens, speaks, and calls browser tools."
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
        <Row label="Voice" note="How the assistant sounds.">
          <Select
            value={settings?.voice ?? ""}
            items={VOICE_VOICES.map((v) => ({ value: v.id, label: v.label }))}
            disabled={settings === null}
            onValueChange={(next: string) => update({ voice: next })}
          >
            <SelectTrigger aria-label="Assistant voice" className="w-[160px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {VOICE_VOICES.map((v) => (
                <SelectItem key={v.id} value={v.id}>
                  {v.hint === undefined ? v.label : `${v.label} — ${v.hint}`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Row>
        <Block
          label="Gemini API key"
          note="Used for voice conversations only. Stored on this Mac (never synced), sent once, and never shown again — replace or remove it below."
        >
          <div className="flex items-center gap-2">
            <Input
              type="password"
              spellCheck={false}
              autoComplete="off"
              aria-label="Gemini API key"
              placeholder={
                settings?.keyState === "stored"
                  ? "Replace the stored key"
                  : "Paste a key"
              }
              value={keyDraft}
              onChange={(e) => setKeyDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                if (keyDraft.trim() === "") return;
                saveKey(keyDraft.trim());
              }}
              className="flex-1 font-mono placeholder:font-sans"
            />
            <Button
              variant="secondary"
              disabled={keyDraft.trim() === ""}
              onClick={() => saveKey(keyDraft.trim())}
            >
              Save
            </Button>
            {settings?.keyState === "stored" ? (
              <Button variant="danger" onClick={() => saveKey("")}>
                Remove
              </Button>
            ) : null}
          </div>
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
