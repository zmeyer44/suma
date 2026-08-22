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
import type {
  RemoteAssistantLinkCode,
  RemoteAssistantOverview,
  RemoteAssistantPolicyPatch,
} from "../../../../../shared/remote-assistant";
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

function useRemoteAssistant(): {
  overview: RemoteAssistantOverview | null;
  linkCode: RemoteAssistantLinkCode | null;
  busy: boolean;
  createLinkCode: () => void;
  revokeLink: (linkId: string) => void;
  updatePolicy: (patch: RemoteAssistantPolicyPatch) => void;
} {
  const pushToast = useSumaStore((s) => s.pushToast);
  const [overview, setOverview] = useState<RemoteAssistantOverview | null>(null);
  const [linkCode, setLinkCode] = useState<RemoteAssistantLinkCode | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void window.suma
      .invoke("remoteAssistant:overview", undefined)
      .then((next) => {
        if (live) setOverview(next);
      })
      .catch(() => {
        if (live) pushToast("Could not read remote assistant access.", "error");
      });
    return () => {
      live = false;
    };
  }, [pushToast]);

  const createLinkCode = useCallback(() => {
    setBusy(true);
    void window.suma
      .invoke("remoteAssistant:createLinkCode", undefined)
      .then(setLinkCode)
      .catch(() => pushToast("Could not create a link code.", "error"))
      .finally(() => setBusy(false));
  }, [pushToast]);

  const revokeLink = useCallback(
    (linkId: string) => {
      setBusy(true);
      void window.suma
        .invoke("remoteAssistant:revokeLink", { linkId })
        .then(setOverview)
        .catch(() => pushToast("Could not disconnect that channel.", "error"))
        .finally(() => setBusy(false));
    },
    [pushToast],
  );

  const updatePolicy = useCallback(
    (patch: RemoteAssistantPolicyPatch) => {
      void window.suma
        .invoke("remoteAssistant:updatePolicy", patch)
        .then((policy) =>
          setOverview((current) =>
            current?.available === true ? { ...current, policy } : current,
          ),
        )
        .catch(() => pushToast("Could not save remote permissions.", "error"));
    },
    [pushToast],
  );

  return { overview, linkCode, busy, createLinkCode, revokeLink, updatePolicy };
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
  const remote = useRemoteAssistant();
  const openSettings = useSumaStore((s) => s.openSettings);
  const [customModel, setCustomModel] = useState("");
  const remotePolicy =
    remote.overview?.available === true ? remote.overview.policy : null;

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
      description="Suma can work from the chat sidebar, voice, or a linked messaging bot. Every remote connection and capability stays visible and revocable here."
    >
      <Group
        title="Connected channels"
        note="Link BlueBubbles now; Slack and Telegram use the same one-time code flow as their adapters become available. Revocation takes effect on the next message."
      >
        {remote.overview === null ? (
          <Row label="Loading remote access…" />
        ) : remote.overview.available === false ? (
          <Row label="Remote access unavailable" note={remote.overview.reason} />
        ) : (
          <>
            <Block
              label="Link a bot"
              note="Create a 10-minute, one-use code, then send /link followed by the code in a direct message to the bot."
            >
              <div className="flex items-center gap-2.5">
                <Button
                  variant="secondary"
                  disabled={remote.busy}
                  onClick={remote.createLinkCode}
                >
                  Create link code
                </Button>
                {remote.linkCode === null ? null : (
                  <div className="flex min-w-0 items-baseline gap-2">
                    <span className="font-mono text-[14px] font-semibold tracking-[0.08em] text-text">
                      {remote.linkCode.code}
                    </span>
                    <span className="text-[10.5px] text-faint">
                      expires {formatTime(remote.linkCode.expiresAt)}
                    </span>
                  </div>
                )}
              </div>
            </Block>
            {remote.overview.links.length === 0 ? (
              <Row
                label="No channels linked"
                note="External messages cannot reach your Suma account until you redeem a link code."
              />
            ) : (
              remote.overview.links.map((link) => (
                <Row
                  key={link.id}
                  label={channelLabel(link.channel)}
                  note={`${link.displayName ?? link.externalUserId} · linked ${formatDate(link.createdAt)}`}
                >
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={remote.busy}
                    onClick={() => remote.revokeLink(link.id)}
                  >
                    Disconnect
                  </Button>
                </Row>
              ))
            )}
          </>
        )}
      </Group>

      {remotePolicy !== null ? (
        <Group
          title="Remote permissions"
          note="These limits apply only to linked bots. The private runner enforces them even if a channel adapter is compromised."
        >
          <Row
            label="Remote model"
            note="The model used for messages that arrive outside the desktop app."
          >
            <Select
              value={remotePolicy.model}
              items={modelItemsFor(remotePolicy.model)}
              onValueChange={(next: string) =>
                remote.updatePolicy({ model: next })
              }
            >
              <SelectTrigger aria-label="Remote assistant model" className="w-[190px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {modelItemsFor(remotePolicy.model).map((entry) => (
                  <SelectItem key={entry.value} value={entry.value}>
                    {entry.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Row>
          {CHAT_TOOL_GROUPS.map((group) => {
            const enabled = remotePolicy.enabledToolGroups.includes(
              group.id,
            );
            return (
              <Row key={group.id} label={group.label} note={group.description}>
                <Switch
                  label={`Remote ${group.label}`}
                  checked={enabled}
                  onChange={(next) => {
                    const current = remotePolicy.enabledToolGroups;
                    remote.updatePolicy({
                      enabledToolGroups: next
                        ? [...new Set([...current, group.id])]
                        : current.filter((id) => id !== group.id),
                    });
                  }}
                />
              </Row>
            );
          })}
          <Row
            label="Maximum tool steps"
            note="Hard cap for one remote request (1–80)."
          >
            <Input
              key={`steps-${String(remotePolicy.maxSteps)}`}
              type="number"
              min={1}
              max={80}
              defaultValue={remotePolicy.maxSteps}
              className="w-[72px] text-right"
              aria-label="Maximum remote tool steps"
              onBlur={(event) => {
                const value = Number(event.currentTarget.value);
                if (Number.isInteger(value) && value >= 1 && value <= 80) {
                  remote.updatePolicy({ maxSteps: value });
                }
              }}
            />
          </Row>
          <Row
            label="Daily wake allowance"
            note="Maximum minutes a linked bot may keep the cloud computer awake each day (0–1,440)."
          >
            <Input
              key={`wake-${String(remotePolicy.dailyWakeMinutes)}`}
              type="number"
              min={0}
              max={1440}
              defaultValue={remotePolicy.dailyWakeMinutes}
              className="w-[82px] text-right"
              aria-label="Daily remote wake minutes"
              onBlur={(event) => {
                const value = Number(event.currentTarget.value);
                if (Number.isInteger(value) && value >= 0 && value <= 1440) {
                  remote.updatePolicy({ dailyWakeMinutes: value });
                }
              }}
            />
          </Row>
          <Row
            label="Auto-suspend after"
            note="Idle minutes before a computer woken by a bot may suspend (1–120)."
          >
            <Input
              key={`suspend-${String(remotePolicy.autoSuspendMinutes)}`}
              type="number"
              min={1}
              max={120}
              defaultValue={remotePolicy.autoSuspendMinutes}
              className="w-[72px] text-right"
              aria-label="Remote auto-suspend minutes"
              onBlur={(event) => {
                const value = Number(event.currentTarget.value);
                if (Number.isInteger(value) && value >= 1 && value <= 120) {
                  remote.updatePolicy({ autoSuspendMinutes: value });
                }
              }}
            />
          </Row>
        </Group>
      ) : null}

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

function modelItemsFor(model: string): Array<{ value: string; label: string }> {
  return CHAT_MODELS.some((entry) => entry.id === model)
    ? MODEL_ITEMS
    : [...MODEL_ITEMS, { value: model, label: model }];
}

function channelLabel(channel: string): string {
  if (channel === "bluebubbles") return "iMessage via BlueBubbles";
  if (channel === "telegram") return "Telegram";
  if (channel === "slack") return "Slack";
  return channel;
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "soon"
    : date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "recently"
    : date.toLocaleDateString([], { month: "short", day: "numeric" });
}
