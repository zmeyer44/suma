"use client";

import {
  ASSISTANT_TOOL_GROUPS,
  type AssistantToolGroupId,
} from "@suma/assistant-core";
import {
  Activity,
  AppWindow,
  ArrowRight,
  Bot,
  Braces,
  Check,
  ChevronDown,
  CircleHelp,
  Clock3,
  ExternalLink,
  Eye,
  FileText,
  Globe2,
  Hash,
  KeyRound,
  LayoutDashboard,
  LockKeyhole,
  LogOut,
  MemoryStick,
  MessageCircleMore,
  MousePointer2,
  Plus,
  Radio,
  RotateCcw,
  Save,
  Settings2,
  ShieldCheck,
  Sparkles,
  SquareTerminal,
  Unplug,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { signOutAction } from "@/app/home/actions";
import { GalaMark } from "@/components/gala-mark";
import { Button } from "@/components/ui/button";

type Section = "overview" | "channels" | "browser" | "permissions" | "agent";
type ChannelId = "bluebubbles" | "slack" | "telegram";

interface SettingsDraft {
  autoSuspendMinutes: number;
  browserSessionSharing: boolean;
  channels: Record<ChannelId, boolean>;
  dailyWakeMinutes: number;
  enabledToolGroups: AssistantToolGroupId[];
  maxSteps: number;
  model: string;
}

const STORAGE_KEY = "gala:settings-draft:v1";
const DEFAULT_DRAFT: SettingsDraft = {
  autoSuspendMinutes: 10,
  browserSessionSharing: true,
  channels: { bluebubbles: false, slack: false, telegram: false },
  dailyWakeMinutes: 120,
  enabledToolGroups: ASSISTANT_TOOL_GROUPS.filter(
    (group) => !("defaultEnabled" in group) || group.defaultEnabled,
  ).map((group) => group.id),
  maxSteps: 40,
  model: "anthropic/claude-sonnet-4.5",
};

const navItems: ReadonlyArray<{
  icon: LucideIcon;
  id: Section;
  label: string;
}> = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "channels", label: "Channels", icon: MessageCircleMore },
  { id: "browser", label: "Browser access", icon: AppWindow },
  { id: "permissions", label: "Permissions", icon: ShieldCheck },
  { id: "agent", label: "Agent settings", icon: Settings2 },
];

const channelDetails: ReadonlyArray<{
  accent: string;
  description: string;
  icon: LucideIcon;
  id: ChannelId;
  label: string;
  note: string;
}> = [
  {
    id: "bluebubbles",
    label: "iMessage",
    note: "BlueBubbles bridge",
    description: "Talk to Gala from any Apple Messages conversation you link.",
    accent: "bg-electric",
    icon: MessageCircleMore,
  },
  {
    id: "slack",
    label: "Slack",
    note: "Workspace bot",
    description: "Bring Gala into DMs or approved channels for your team.",
    accent: "bg-coral",
    icon: Hash,
  },
  {
    id: "telegram",
    label: "Telegram",
    note: "Private bot",
    description: "Keep Gala close in a personal or group Telegram chat.",
    accent: "bg-violet",
    icon: Radio,
  },
];

const toolIcons: Record<AssistantToolGroupId, LucideIcon> = {
  tabs: AppWindow,
  navigate: Globe2,
  history: RotateCcw,
  read: FileText,
  screenshot: Eye,
  interact: MousePointer2,
  memory: MemoryStick,
  files: Braces,
  terminal: SquareTerminal,
};

function parseDraft(value: string): SettingsDraft | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null) return null;
    return { ...DEFAULT_DRAFT, ...parsed } as SettingsDraft;
  } catch {
    return null;
  }
}

function Toggle({
  active,
  label,
  onChange,
}: {
  active: boolean;
  label: string;
  onChange: () => void;
}) {
  return (
    <Button
      type="button"
      variant="bare"
      size="none"
      role="switch"
      aria-checked={active}
      aria-label={label}
      data-active={active}
      onClick={onChange}
      className={`switch block h-7 w-12 shrink-0 rounded-full border p-0.5 transition-colors ${
        active ? "border-lime bg-lime" : "border-line bg-[#d9dde2]"
      }`}
    >
      <span className="switch-thumb block size-5 rounded-full bg-white shadow-sm" />
    </Button>
  );
}

function PanelHeading({
  eyebrow,
  title,
  copy,
}: {
  copy: string;
  eyebrow: string;
  title: string;
}) {
  return (
    <div className="mb-8 flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
      <div>
        <p className="eyebrow text-violet">{eyebrow}</p>
        <h1 className="font-display mt-2 text-4xl font-semibold leading-[1] tracking-[-0.04em] sm:text-5xl">
          {title}
        </h1>
      </div>
      <p className="max-w-md text-sm leading-6 text-muted">{copy}</p>
    </div>
  );
}

export function GalaConsole({ email }: { email: string }) {
  const [activeSection, setActiveSection] = useState<Section>("overview");
  const [draft, setDraft] = useState<SettingsDraft>(DEFAULT_DRAFT);
  const [dirty, setDirty] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [configuring, setConfiguring] = useState<ChannelId | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = parseDraft(stored);
      if (parsed) setDraft(parsed);
    }
    setLoaded(true);
  }, []);

  const connectedCount = useMemo(
    () => Object.values(draft.channels).filter(Boolean).length,
    [draft.channels],
  );

  function updateDraft(update: (current: SettingsDraft) => SettingsDraft) {
    setDraft(update);
    setDirty(true);
    setNotice(null);
  }

  function saveDraft() {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(draft));
    setDirty(false);
    setNotice("Draft saved in this browser");
    window.setTimeout(() => setNotice(null), 2_800);
  }

  function configureChannel(id: ChannelId) {
    updateDraft((current) => ({
      ...current,
      channels: { ...current.channels, [id]: true },
    }));
    setConfiguring(null);
    setNotice("Channel draft updated — save when you’re ready");
  }

  const initials = email.slice(0, 2).toUpperCase();

  return (
    <main className="min-h-dvh bg-cream lg:grid lg:grid-cols-[236px_1fr]">
      <aside className="dashboard-grid hidden min-h-dvh flex-col bg-ink px-4 py-5 text-white lg:flex">
        <div className="px-2">
          <GalaMark inverted />
        </div>
        <div className="mt-10 rounded-sm border border-white/10 bg-white/5 p-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-xs">
              <span className="relative flex size-2">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-lime opacity-50" />
                <span className="relative inline-flex size-2 rounded-full bg-lime" />
              </span>
              Gala
            </div>
            <span className="rounded-full bg-white/10 px-2 py-1 text-[0.55rem] uppercase tracking-[0.12em] text-white/45">
              Draft
            </span>
          </div>
          <p className="mt-2 text-[0.65rem] leading-4 text-white/35">
            Control-plane connection pending
          </p>
        </div>
        <nav className="mt-7 space-y-1" aria-label="Gala settings">
          {navItems.map(({ id, label, icon: Icon }) => {
            const active = activeSection === id;
            return (
              <Button
                key={id}
                type="button"
                variant="bare"
                size="none"
                onClick={() => setActiveSection(id)}
                className={`flex w-full items-center gap-3 rounded-sm px-3 py-2.5 text-left text-xs transition-colors ${
                  active
                    ? "bg-white text-ink"
                    : "text-white/50 hover:bg-white/5 hover:text-white"
                }`}
              >
                <Icon className="size-4" strokeWidth={active ? 2 : 1.6} />
                {label}
              </Button>
            );
          })}
        </nav>
        <div className="mt-auto border-t border-white/10 pt-4">
          <div className="mb-3 flex items-center gap-3 px-2">
            <span className="grid size-8 place-items-center rounded-full bg-violet text-[0.6rem] font-semibold text-white">
              {initials}
            </span>
            <div className="min-w-0">
              <p className="truncate text-[0.68rem]">{email}</p>
              <p className="text-[0.58rem] text-white/35">Workspace owner</p>
            </div>
          </div>
          <form action={signOutAction}>
            <Button
              type="submit"
              variant="bare"
              size="none"
              className="flex w-full items-center gap-3 rounded-sm px-3 py-2.5 text-left text-xs text-white/45 transition-colors hover:bg-white/5 hover:text-white"
            >
              <LogOut className="size-4" />
              Sign out
            </Button>
          </form>
        </div>
      </aside>

      <div className="min-w-0">
        <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-ink/10 bg-white/90 px-4 py-3 backdrop-blur-xl lg:hidden">
          <GalaMark compact />
          <nav
            className="flex min-w-0 flex-1 gap-1 overflow-x-auto"
            aria-label="Gala settings"
          >
            {navItems.map(({ id, label }) => (
              <Button
                key={id}
                type="button"
                variant="bare"
                size="none"
                onClick={() => setActiveSection(id)}
                className={`whitespace-nowrap rounded-full px-3 py-2 text-[0.65rem] ${activeSection === id ? "bg-ink text-white" : "text-muted"}`}
              >
                {label}
              </Button>
            ))}
          </nav>
          <form action={signOutAction} className="shrink-0">
            <Button
              type="submit"
              variant="bare"
              size="none"
              aria-label="Sign out"
              className="grid size-9 place-items-center rounded-full border border-ink/10 bg-cream-bright"
            >
              <LogOut className="size-3.5" />
            </Button>
          </form>
        </header>

        <div className="mx-auto max-w-[1280px] px-4 py-5 sm:px-7 sm:py-8 xl:px-10">
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3 border border-ink/10 bg-white px-4 py-3">
            <div className="flex items-center gap-2 text-[0.68rem] text-muted">
              <CircleHelp className="size-3.5 text-violet" />
              Settings are currently a local draft. Suma identity sync is the
              next connection step.
            </div>
            <div className="flex items-center gap-2">
              {notice && (
                <span
                  role="status"
                  className="hidden text-[0.65rem] text-muted sm:inline"
                >
                  {notice}
                </span>
              )}
              <Button
                type="button"
                variant="bare"
                size="none"
                disabled={!dirty || !loaded}
                onClick={saveDraft}
                className="inline-flex items-center gap-2 bg-ink px-4 py-2 text-[0.68rem] text-white transition-colors enabled:hover:bg-coral disabled:cursor-not-allowed disabled:opacity-35"
              >
                <Save className="size-3.5" />
                Save draft
              </Button>
            </div>
          </div>

          {activeSection === "overview" && (
            <Overview
              connectedCount={connectedCount}
              draft={draft}
              onNavigate={setActiveSection}
            />
          )}
          {activeSection === "channels" && (
            <Channels
              channels={draft.channels}
              configuring={configuring}
              onClose={() => setConfiguring(null)}
              onConfigure={configureChannel}
              onOpen={setConfiguring}
              onRevoke={(id) =>
                updateDraft((current) => ({
                  ...current,
                  channels: { ...current.channels, [id]: false },
                }))
              }
            />
          )}
          {activeSection === "browser" && (
            <BrowserAccess
              enabled={draft.browserSessionSharing}
              onToggle={() =>
                updateDraft((current) => ({
                  ...current,
                  browserSessionSharing: !current.browserSessionSharing,
                }))
              }
            />
          )}
          {activeSection === "permissions" && (
            <Permissions
              enabled={draft.enabledToolGroups}
              onToggle={(id) =>
                updateDraft((current) => ({
                  ...current,
                  enabledToolGroups: current.enabledToolGroups.includes(id)
                    ? current.enabledToolGroups.filter(
                        (candidate) => candidate !== id,
                      )
                    : [...current.enabledToolGroups, id],
                }))
              }
            />
          )}
          {activeSection === "agent" && (
            <AgentSettings
              draft={draft}
              onChange={(patch) =>
                updateDraft((current) => ({ ...current, ...patch }))
              }
            />
          )}
        </div>
      </div>
    </main>
  );
}

function Overview({
  connectedCount,
  draft,
  onNavigate,
}: {
  connectedCount: number;
  draft: SettingsDraft;
  onNavigate: (section: Section) => void;
}) {
  return (
    <section>
      <PanelHeading
        eyebrow="Good afternoon"
        title="Gala control room"
        copy="The essentials at a glance. Finish the connection steps, then this becomes the live pulse of your agent."
      />
      <div className="grid gap-4 xl:grid-cols-[1.3fr_0.7fr]">
        <article className="dashboard-grid relative min-h-[340px] overflow-hidden rounded-sm bg-plum p-6 text-white sm:p-8">
          <div className="absolute -right-24 -top-32 size-96 rounded-full border border-white/10" />
          <div className="absolute right-8 top-8 grid size-28 place-items-center bg-lime text-white shadow-[0_0_50px_rgba(243,93,61,0.16)] sm:size-36">
            <span className="font-display text-6xl font-black sm:text-7xl">
              G
            </span>
          </div>
          <div className="relative flex h-full max-w-md flex-col justify-between">
            <div className="flex items-center gap-2 text-[0.63rem] uppercase tracking-[0.16em] text-white/45">
              <span className="size-1.5 rounded-full bg-lime" />
              Operator setup
            </div>
            <div className="mt-32 sm:mt-28">
              <h2 className="font-display text-4xl font-semibold leading-[1] tracking-[-0.035em] sm:text-5xl">
                Give Gala a way in.
              </h2>
              <p className="mt-4 max-w-sm text-sm leading-6 text-white/50">
                Link one conversation and authorize browser sharing to start
                using Gala away from desktop.
              </p>
              <Button
                type="button"
                variant="bare"
                size="none"
                onClick={() => onNavigate("channels")}
                className="group mt-6 inline-flex items-center gap-2 bg-white px-4 py-2.5 text-xs text-ink"
              >
                Connect a channel
                <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
              </Button>
            </div>
          </div>
        </article>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-1">
          <article className="rounded-sm bg-cream-bright p-6">
            <div className="flex items-center justify-between">
              <span className="grid size-10 place-items-center rounded-full bg-[#e7e9ea]">
                <MessageCircleMore className="size-4" />
              </span>
              <span className="text-[0.62rem] uppercase tracking-[0.14em] text-muted">
                Channels
              </span>
            </div>
            <p className="font-display mt-8 text-5xl">
              {connectedCount}
              <span className="text-muted/30">/3</span>
            </p>
            <p className="mt-2 text-xs text-muted">connection drafts ready</p>
          </article>
          <article className="rounded-sm bg-lime p-6">
            <div className="flex items-center justify-between">
              <span className="grid size-10 place-items-center rounded-full bg-ink text-lime">
                <Zap className="size-4" />
              </span>
              <span className="text-[0.62rem] uppercase tracking-[0.14em] text-ink/55">
                Tools
              </span>
            </div>
            <p className="font-display mt-8 text-5xl">
              {draft.enabledToolGroups.length}
              <span className="text-ink/25">/9</span>
            </p>
            <p className="mt-2 text-xs text-ink/55">
              permission groups enabled
            </p>
          </article>
        </div>
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <article className="rounded-sm bg-cream-bright p-6 sm:p-7">
          <div className="flex items-center justify-between">
            <h3 className="font-display text-2xl">Setup path</h3>
            <span className="rounded-full bg-coral/10 px-2.5 py-1 text-[0.58rem] uppercase tracking-[0.12em] text-coral">
              2 steps left
            </span>
          </div>
          <div className="mt-6 space-y-1">
            {[
              { done: true, label: "Create your Gala operator session" },
              {
                done: connectedCount > 0,
                label: "Link your first conversation",
              },
              {
                done: draft.browserSessionSharing,
                label: "Allow signed-in browser sharing",
              },
              { done: false, label: "Connect Gala to the Suma control plane" },
            ].map((item) => (
              <div
                key={item.label}
                className="flex items-center gap-3 border-t border-line py-3 first:border-t-0"
              >
                <span
                  className={`grid size-5 place-items-center rounded-full ${item.done ? "bg-ink text-lime" : "border border-line text-transparent"}`}
                >
                  <Check className="size-3" />
                </span>
                <span
                  className={`text-xs ${item.done ? "text-ink" : "text-muted"}`}
                >
                  {item.label}
                </span>
              </div>
            ))}
          </div>
        </article>
        <article className="rounded-sm bg-cream-bright p-6 sm:p-7">
          <div className="flex items-center justify-between">
            <h3 className="font-display text-2xl">Recent activity</h3>
            <Activity className="size-4 text-muted" />
          </div>
          <div className="mt-9 flex min-h-36 flex-col items-center justify-center rounded-sm border border-dashed border-line text-center">
            <Sparkles className="size-5 text-violet" />
            <p className="mt-3 text-xs">The room is quiet.</p>
            <p className="mt-1 max-w-xs text-[0.65rem] leading-5 text-muted">
              Live requests and sensitive actions will appear here once the
              control plane is connected.
            </p>
          </div>
        </article>
      </div>
    </section>
  );
}

function Channels({
  channels,
  configuring,
  onClose,
  onConfigure,
  onOpen,
  onRevoke,
}: {
  channels: Record<ChannelId, boolean>;
  configuring: ChannelId | null;
  onClose: () => void;
  onConfigure: (id: ChannelId) => void;
  onOpen: (id: ChannelId) => void;
  onRevoke: (id: ChannelId) => void;
}) {
  const selected = channelDetails.find((channel) => channel.id === configuring);
  return (
    <section>
      <PanelHeading
        eyebrow="Communication pipes"
        title="Find Gala anywhere"
        copy="Each external identity is linked independently. Revoking one channel never affects the others."
      />
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {channelDetails.map(
          ({ id, label, note, description, accent, icon: Icon }) => {
            const connected = channels[id];
            return (
              <article
                key={id}
                data-testid={`channel-${id}`}
                className="relative overflow-hidden rounded-sm bg-cream-bright p-6"
              >
                <span
                  className={`absolute right-0 top-0 h-1.5 w-full ${accent}`}
                />
                <div className="flex items-center justify-between">
                  <span className="grid size-11 place-items-center rounded-full bg-[#e7e9ea]">
                    <Icon className="size-4.5" />
                  </span>
                  <span
                    className={`rounded-full px-2.5 py-1 text-[0.57rem] uppercase tracking-[0.12em] ${connected ? "bg-lime text-ink" : "bg-[#e7e9ea] text-muted"}`}
                  >
                    {connected ? "Draft ready" : "Not linked"}
                  </span>
                </div>
                <h2 className="font-display mt-12 text-3xl">{label}</h2>
                <p className="mt-1 text-[0.66rem] uppercase tracking-[0.1em] text-muted">
                  {note}
                </p>
                <p className="mt-5 min-h-12 text-xs leading-5 text-muted">
                  {description}
                </p>
                {connected ? (
                  <Button
                    type="button"
                    variant="bare"
                    size="none"
                    onClick={() => onRevoke(id)}
                    className="mt-7 inline-flex items-center gap-2 text-xs text-[#b52e14] transition-none hover:underline"
                  >
                    <Unplug className="size-3.5" />
                    Remove draft
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="bare"
                    size="none"
                    onClick={() => onOpen(id)}
                    className="group mt-7 inline-flex items-center gap-2 bg-ink px-4 py-2.5 text-xs text-white transition-colors hover:bg-coral"
                  >
                    Configure
                    <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
                  </Button>
                )}
              </article>
            );
          },
        )}
      </div>
      <div className="mt-4 flex items-start gap-3 rounded-sm border border-ink/10 bg-cream-bright/60 p-4 text-xs leading-5 text-muted">
        <LockKeyhole className="mt-0.5 size-4 shrink-0 text-violet" />
        Bot tokens and bridge passwords are deliberately not retained in this
        browser draft. They will be submitted directly to encrypted
        control-plane storage when the identity connection lands.
      </div>

      {selected && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-end bg-ink/35 p-3 backdrop-blur-sm sm:p-5"
          role="presentation"
          onMouseDown={onClose}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-label={`Configure ${selected.label}`}
            onMouseDown={(event) => event.stopPropagation()}
            className="max-h-[calc(100dvh-24px)] w-full overflow-y-auto rounded-sm bg-cream-bright p-6 shadow-2xl sm:max-w-lg sm:p-8"
          >
            <div className="flex items-center justify-between">
              <span
                className={`grid size-11 place-items-center rounded-full ${selected.accent}`}
              >
                <selected.icon className="size-4.5" />
              </span>
              <Button
                type="button"
                variant="bare"
                size="none"
                aria-label="Close"
                onClick={onClose}
                className="grid size-9 place-items-center rounded-full border border-line hover:bg-[#e7e9ea]"
              >
                <X className="size-4" />
              </Button>
            </div>
            <p className="eyebrow mt-10 text-violet">{selected.note}</p>
            <h2 className="font-display mt-2 text-4xl">
              Connect {selected.label}
            </h2>
            <p className="mt-4 text-sm leading-6 text-muted">
              This saves the non-secret connection draft. Secret exchange will
              activate when Gala is connected to Suma identity.
            </p>
            <div className="mt-8 space-y-4">
              <label className="block">
                <span className="mb-2 block text-xs text-muted">
                  Connection label
                </span>
                <input
                  defaultValue={
                    selected.id === "bluebubbles"
                      ? "Personal Messages"
                      : `My ${selected.label}`
                  }
                  className="w-full rounded-sm border border-line bg-transparent px-4 py-3 text-sm outline-none focus:border-ink"
                />
              </label>
              <label className="block">
                <span className="mb-2 block text-xs text-muted">
                  Who may message Gala
                </span>
                <span className="relative block">
                  <select
                    defaultValue="linked"
                    className="w-full appearance-none rounded-sm border border-line bg-transparent px-4 py-3 text-sm outline-none focus:border-ink"
                  >
                    <option value="linked">Only linked identities</option>
                    <option value="approved">
                      Linked identities and approved rooms
                    </option>
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-4 top-1/2 size-4 -translate-y-1/2 text-muted" />
                </span>
              </label>
            </div>
            <Button
              type="button"
              variant="bare"
              size="none"
              onClick={() => onConfigure(selected.id)}
              className="mt-8 flex w-full items-center justify-between bg-ink px-5 py-3.5 text-sm text-white transition-colors hover:bg-coral"
            >
              Save connection draft
              <ArrowRight className="size-4" />
            </Button>
          </section>
        </div>
      )}
    </section>
  );
}

function BrowserAccess({
  enabled,
  onToggle,
}: {
  enabled: boolean;
  onToggle: () => void;
}) {
  return (
    <section>
      <PanelHeading
        eyebrow="Authenticated browser"
        title="Let Gala use your seat"
        copy="Share an encrypted Suma browser state when possible, then add scoped service credentials for sites that need another route in."
      />
      <div className="grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
        <article className="relative overflow-hidden rounded-sm bg-plum p-6 text-white sm:p-8">
          <div className="absolute -right-20 -top-28 size-80 rounded-full border border-white/10" />
          <div className="relative flex items-start justify-between gap-5">
            <span className="grid size-12 place-items-center rounded-full bg-lime text-plum">
              <AppWindow className="size-5" />
            </span>
            <Toggle
              active={enabled}
              label="Share signed-in browser session"
              onChange={onToggle}
            />
          </div>
          <div className="relative mt-24 max-w-lg">
            <div className="flex items-center gap-2 text-[0.62rem] uppercase tracking-[0.14em] text-white/40">
              <span
                className={`size-1.5 rounded-full ${enabled ? "bg-lime" : "bg-coral"}`}
              />
              {enabled ? "Allowed in draft" : "Not allowed"}
            </div>
            <h2 className="font-display mt-4 text-4xl">Use my Suma session</h2>
            <p className="mt-4 text-sm leading-6 text-white/50">
              Gala receives an encrypted, short-lived handoff and imports it
              into the remote browser context. Full navigation, clicking,
              typing, scrolling, and uploads remain governed by your tool
              policy.
            </p>
          </div>
        </article>
        <article className="rounded-sm bg-cream-bright p-6 sm:p-8">
          <div className="flex items-center justify-between">
            <span className="grid size-11 place-items-center rounded-full bg-[#e7e9ea]">
              <KeyRound className="size-4.5" />
            </span>
            <span className="rounded-full bg-[#e7e9ea] px-2.5 py-1 text-[0.57rem] uppercase tracking-[0.12em] text-muted">
              0 saved
            </span>
          </div>
          <h2 className="font-display mt-12 text-3xl">Custom credentials</h2>
          <p className="mt-4 text-xs leading-5 text-muted">
            Scope an API token or header to an exact HTTPS origin and path
            boundary. Secrets belong in the encrypted assistant store—not
            localStorage.
          </p>
          <Button
            type="button"
            variant="bare"
            size="none"
            disabled
            className="mt-8 inline-flex cursor-not-allowed items-center gap-2 border border-line px-4 py-2.5 text-xs text-muted opacity-65"
            title="Requires the Suma identity connection"
          >
            <Plus className="size-3.5" />
            Add credential after sync
          </Button>
        </article>
      </div>
      <div className="mt-4 grid gap-4 md:grid-cols-3">
        {[
          {
            icon: Globe2,
            label: "Origin-bound",
            copy: "Credentials are never forwarded to a different host.",
          },
          {
            icon: LockKeyhole,
            label: "Path-scoped",
            copy: "A token can be limited to one exact route tree.",
          },
          {
            icon: Activity,
            label: "Auditable",
            copy: "Sensitive browser actions are visible in activity.",
          },
        ].map(({ icon: Icon, label, copy }) => (
          <article
            key={label}
            className="rounded-sm border border-ink/10 bg-cream-bright/55 p-5"
          >
            <Icon className="size-4 text-violet" />
            <h3 className="mt-6 text-sm">{label}</h3>
            <p className="mt-2 text-[0.66rem] leading-5 text-muted">{copy}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

function Permissions({
  enabled,
  onToggle,
}: {
  enabled: AssistantToolGroupId[];
  onToggle: (id: AssistantToolGroupId) => void;
}) {
  return (
    <section>
      <PanelHeading
        eyebrow="Capability policy"
        title="Decide what Gala may do"
        copy="These are the same shared tool groups used by the desktop and external assistant harness—no smaller shadow catalog."
      />
      <div className="overflow-hidden rounded-sm bg-cream-bright">
        {ASSISTANT_TOOL_GROUPS.map((group) => {
          const Icon = toolIcons[group.id];
          const active = enabled.includes(group.id);
          return (
            <div
              key={group.id}
              data-testid={`permission-${group.id}`}
              className="grid items-center gap-4 border-t border-line px-5 py-5 first:border-t-0 sm:grid-cols-[44px_1fr_auto] sm:px-7"
            >
              <span
                className={`grid size-11 place-items-center rounded-full ${active ? "bg-ink text-lime" : "bg-[#e7e9ea] text-muted"}`}
              >
                <Icon className="size-4.5" />
              </span>
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-sm">{group.label}</h2>
                  {"defaultEnabled" in group && !group.defaultEnabled && (
                    <span className="rounded-full bg-coral/10 px-2 py-0.5 text-[0.55rem] uppercase tracking-[0.1em] text-coral">
                      Explicit opt-in
                    </span>
                  )}
                </div>
                <p className="mt-1 text-[0.68rem] leading-5 text-muted">
                  {group.description}
                </p>
              </div>
              <div className="justify-self-end sm:col-start-3 sm:row-start-1">
                <Toggle
                  active={active}
                  label={`${active ? "Disable" : "Enable"} ${group.label}`}
                  onChange={() => onToggle(group.id)}
                />
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function AgentSettings({
  draft,
  onChange,
}: {
  draft: SettingsDraft;
  onChange: (patch: Partial<SettingsDraft>) => void;
}) {
  return (
    <section>
      <PanelHeading
        eyebrow="Runtime policy"
        title="Set Gala’s working style"
        copy="Choose the model and boundaries applied to every external channel. These values mirror the assistant policy owned by Suma control."
      />
      <div className="grid gap-4 xl:grid-cols-[1.15fr_0.85fr]">
        <article className="rounded-sm bg-cream-bright p-6 sm:p-8">
          <div className="flex items-center gap-3 border-b border-line pb-6">
            <span className="grid size-11 place-items-center rounded-full bg-violet text-white">
              <Bot className="size-4.5" />
            </span>
            <div>
              <h2 className="font-display text-2xl">Core model</h2>
              <p className="mt-1 text-[0.65rem] text-muted">
                Used for linked-channel tasks
              </p>
            </div>
          </div>
          <label className="mt-7 block">
            <span className="mb-2 block text-xs text-muted">Model route</span>
            <span className="relative block">
              <select
                value={draft.model}
                onChange={(event) => onChange({ model: event.target.value })}
                className="w-full appearance-none rounded-sm border border-line bg-transparent px-4 py-3.5 text-sm outline-none focus:border-ink"
              >
                <option value="anthropic/claude-sonnet-4.5">
                  Claude Sonnet 4.5
                </option>
                <option value="openai/gpt-5.4">GPT-5.4</option>
                <option value="google/gemini-2.5-pro">Gemini 2.5 Pro</option>
              </select>
              <ChevronDown className="pointer-events-none absolute right-4 top-1/2 size-4 -translate-y-1/2 text-muted" />
            </span>
          </label>
          <label className="mt-6 block">
            <span className="mb-2 flex items-center justify-between text-xs text-muted">
              Maximum steps per task
              <strong className="font-normal text-ink">{draft.maxSteps}</strong>
            </span>
            <input
              type="range"
              min="1"
              max="80"
              value={draft.maxSteps}
              onChange={(event) =>
                onChange({ maxSteps: Number(event.target.value) })
              }
              className="w-full accent-violet"
            />
          </label>
        </article>
        <article className="rounded-sm bg-ink p-6 text-white sm:p-8">
          <div className="flex items-center justify-between">
            <span className="grid size-11 place-items-center rounded-full bg-lime text-ink">
              <Clock3 className="size-4.5" />
            </span>
            <span className="text-[0.6rem] uppercase tracking-[0.14em] text-white/35">
              Machine time
            </span>
          </div>
          <h2 className="font-display mt-10 text-3xl">Wake budget</h2>
          <p className="mt-3 text-xs leading-5 text-white/45">
            Limit how long external requests may wake a suspended Suma VM each
            day.
          </p>
          <div className="mt-8 grid grid-cols-2 gap-3">
            <label className="rounded-sm bg-white/5 p-4">
              <span className="block text-[0.6rem] text-white/40">
                Daily minutes
              </span>
              <input
                type="number"
                min="0"
                max="1440"
                value={draft.dailyWakeMinutes}
                onChange={(event) =>
                  onChange({ dailyWakeMinutes: Number(event.target.value) })
                }
                className="mt-2 w-full bg-transparent font-display text-3xl outline-none"
              />
            </label>
            <label className="rounded-sm bg-white/5 p-4">
              <span className="block text-[0.6rem] text-white/40">
                Suspend after
              </span>
              <input
                type="number"
                min="1"
                max="120"
                value={draft.autoSuspendMinutes}
                onChange={(event) =>
                  onChange({ autoSuspendMinutes: Number(event.target.value) })
                }
                className="mt-2 w-full bg-transparent font-display text-3xl outline-none"
              />
            </label>
          </div>
          <p className="mt-4 flex items-center gap-2 text-[0.6rem] text-white/35">
            <LockKeyhole className="size-3" /> Hard limits remain enforced by
            Suma control
          </p>
        </article>
      </div>
      <article className="mt-4 flex flex-col gap-5 rounded-sm border border-ink/10 bg-cream-bright/60 p-6 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-4">
          <span className="grid size-11 place-items-center rounded-full bg-[#e7e9ea]">
            <ExternalLink className="size-4" />
          </span>
          <div>
            <h3 className="text-sm">System prompt and memory</h3>
            <p className="mt-1 text-[0.66rem] text-muted">
              Managed by the shared Suma agent harness.
            </p>
          </div>
        </div>
        <span className="text-[0.62rem] uppercase tracking-[0.12em] text-muted">
          Coming with identity sync
        </span>
      </article>
    </section>
  );
}
