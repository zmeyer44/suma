/**
 * `suma://settings/assistant` — which model answers in the chat sidebar, and
 * what the assistant is allowed to do to the browser.
 *
 * Both halves are main's state (chat.json, via `chat:settings` /
 * `chat:updateSettings`): the agent loop runs there, so main is the enforcer
 * of every toggle on this page — a disabled capability's tools are simply
 * never handed to the model. The gateway KEY is deliberately not edited
 * here: it is the same Vercel AI Gateway credential the voice features use,
 * so the page reports where it came from and links to Voice & audio to
 * change it, instead of growing a second copy of the key field.
 */

import { useCallback, useEffect, useState } from "react";
import {
  CHAT_MODELS,
  CHAT_TOOL_GROUPS,
  type ChatSettingsInfo,
  type ChatSettingsPatch,
} from "../../../../../shared/chat";
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

const MODEL_ITEMS = CHAT_MODELS.map((model) => ({
  value: model.id,
  label: model.label,
}));

/**
 * The page's copy of main's assistant settings — loaded once, then updated
 * from the reply to every write, so it always shows what was really stored.
 */
function useChatSettings(): {
  settings: ChatSettingsInfo | null;
  update: (patch: ChatSettingsPatch) => void;
} {
  const pushToast = useSumaStore((s) => s.pushToast);
  const [settings, setSettings] = useState<ChatSettingsInfo | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const next = await window.suma.invoke("chat:settings", undefined);
        if (live) setSettings(next);
      } catch {
        if (live) pushToast("Could not read the assistant settings.", "error");
      }
    })();
    return () => {
      live = false;
    };
  }, [pushToast]);

  const update = useCallback(
    (patch: ChatSettingsPatch) => {
      void (async () => {
        try {
          setSettings(await window.suma.invoke("chat:updateSettings", patch));
        } catch {
          pushToast("Could not save the assistant settings.", "error");
        }
      })();
    },
    [pushToast],
  );

  return { settings, update };
}

const KEY_NOTES: Record<ChatSettingsInfo["keyState"], string> = {
  env: "Using the AI Gateway key from the environment (AI_GATEWAY_API_KEY).",
  stored:
    "Using the Vercel AI Gateway key stored under Settings → Voice & audio.",
  vended:
    "Using model access included with your Suma account. Add your own AI Gateway key under Settings → Voice & audio to use it instead.",
  unset:
    "No model access yet — sign in to your Suma account, add a Vercel AI Gateway key under Settings → Voice & audio, or set AI_GATEWAY_API_KEY.",
};

export function AssistantPage() {
  const { settings, update } = useChatSettings();
  const openSettings = useSumaStore((s) => s.openSettings);
  const [customModel, setCustomModel] = useState("");

  const model = settings?.model ?? "";
  const isCuratedModel = CHAT_MODELS.some((entry) => entry.id === model);
  // A free-typed model shows in the trigger as its raw id, not a blank.
  const modelItems = isCuratedModel
    ? MODEL_ITEMS
    : [...MODEL_ITEMS, { value: model, label: model }];

  const saveCustomModel = (): void => {
    const value = customModel.trim();
    if (value === "") return;
    update({ model: value });
    setCustomModel("");
  };

  return (
    <Page
      title="Assistant"
      description="The AI in the chat sidebar (⌘I). It answers with the model you pick here, and can work the browser for you — every capability below is yours to grant or revoke."
    >
      <Group title="Model" note={KEY_NOTES[settings?.keyState ?? "unset"]}>
        <Row
          label="Model"
          note="Runs through the Vercel AI Gateway, so any gateway-routable model works."
        >
          <Select
            value={model}
            items={modelItems}
            disabled={settings === null}
            onValueChange={(next: string) => update({ model: next })}
          >
            <SelectTrigger aria-label="Assistant model" className="w-[190px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {modelItems.map((entry) => {
                const hint = CHAT_MODELS.find((m) => m.id === entry.value)?.hint;
                return (
                  <SelectItem key={entry.value} value={entry.value}>
                    {hint === undefined ? entry.label : `${entry.label} — ${hint}`}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        </Row>

        <Block
          label="Custom model"
          note="Any AI Gateway model id, e.g. anthropic/claude-sonnet-5 or openai/gpt-5.1."
        >
          <div className="flex items-center gap-2">
            <Input
              spellCheck={false}
              autoComplete="off"
              aria-label="Custom model id"
              placeholder="provider/model"
              value={customModel}
              onChange={(e) => setCustomModel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                saveCustomModel();
              }}
              className="flex-1 font-mono placeholder:font-sans"
            />
            <Button
              variant="secondary"
              disabled={customModel.trim() === "" || settings === null}
              onClick={saveCustomModel}
            >
              Use
            </Button>
          </div>
        </Block>

        {settings?.keyState !== "env" ? (
          <Block>
            <Button variant="secondary" onClick={() => void openSettings("voice")}>
              Manage the AI Gateway key…
            </Button>
          </Block>
        ) : null}
      </Group>

      <Group
        title="Browser tools"
        note="What the assistant may do with your browser while answering. Switching one off takes effect on the next message — the model is simply never offered those tools."
      >
        {CHAT_TOOL_GROUPS.map((group) => (
          <Row key={group.id} label={group.label} note={group.description}>
            <Switch
              label={group.label}
              checked={settings?.tools[group.id] ?? true}
              disabled={settings === null}
              onChange={(next) => update({ tools: { [group.id]: next } })}
            />
          </Row>
        ))}
      </Group>
    </Page>
  );
}
