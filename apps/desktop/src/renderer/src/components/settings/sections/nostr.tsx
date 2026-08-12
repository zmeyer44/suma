/**
 * `suma://settings/nostr` — the signer behind every tab's `window.nostr`
 * (NIP-07).
 *
 * Three concerns, three groups. IDENTITY follows the API-key posture from
 * Voice & audio, hardened for a key that cannot be reissued: the nsec is
 * never redisplayed (the field is replace-only), and a freshly generated
 * key is shown exactly once, from the generate reply, for backing up.
 * RELAYS is what `getRelays()` answers. SITE PERMISSIONS is the standing
 * rules — per method, and per event KIND for signing, which is the whole
 * point: "primal.net may update my follow list (kind 3) without asking, but
 * asks before posting a note (kind 1)" is two selects on this page.
 */

import { useEffect, useState } from "react";
import { Bot, Check, Copy, LoaderCircle, Plus, RefreshCw, TriangleAlert, X } from "lucide-react";
import {
  NOSTR_KIND_LABELS,
  nostrKindLabel,
  truncateNpub,
  type BuzzAgent,
  type NostrMethod,
  type NostrPermissionChoice,
  type NostrSettingsInfo,
  type NostrSitePolicy,
} from "../../../../../shared/nostr";
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

/* ------------------------------- helpers -------------------------------- */

const CHOICES: NostrPermissionChoice[] = ["allow", "ask", "deny"];
const CHOICE_LABEL: Record<NostrPermissionChoice, string> = {
  allow: "Allow",
  ask: "Ask",
  deny: "Deny",
};
const CHOICE_ITEMS = CHOICES.map((choice) => ({
  value: choice,
  label: CHOICE_LABEL[choice],
}));

function ChoiceSelect({
  value,
  onChange,
  ariaLabel,
}: {
  value: NostrPermissionChoice;
  onChange: (choice: NostrPermissionChoice) => void;
  ariaLabel: string;
}) {
  return (
    <Select value={value} items={CHOICE_ITEMS} onValueChange={onChange}>
      <SelectTrigger aria-label={ariaLabel} className="w-[84px]">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {CHOICES.map((choice) => (
          <SelectItem key={choice} value={choice}>
            {CHOICE_LABEL[choice]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="ghost"
      size="icon"
      title={label}
      aria-label={label}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? (
        <Check className="size-3 text-ok" aria-hidden="true" />
      ) : (
        <Copy className="size-3" aria-hidden="true" />
      )}
    </Button>
  );
}

/* ------------------------------- identity ------------------------------- */

function IdentityGroup({ settings }: { settings: NostrSettingsInfo }) {
  const setNostrKey = useSumaStore((s) => s.setNostrKey);
  const generateNostrKey = useSumaStore((s) => s.generateNostrKey);
  const removeNostrKey = useSumaStore((s) => s.removeNostrKey);
  const [draft, setDraft] = useState("");
  /** The shown-once nsec from a fresh generate — local, never in the store. */
  const [revealedNsec, setRevealedNsec] = useState<string | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  const save = async (): Promise<void> => {
    const key = draft.trim();
    if (key === "") return;
    if (await setNostrKey(key)) setDraft("");
  };

  return (
    <Group
      title="Identity"
      note="The key that signs as you. It stays on this Mac, encrypted at rest, and is never shown again once saved — sites see only signatures you approve."
    >
      {settings.keyConfigured && settings.npub !== null ? (
        <Row
          label="Public key"
          note="Share this freely — it is your Nostr identity, not a secret."
        >
          <span className="flex max-w-[260px] items-center gap-1">
            <span
              title={settings.npub}
              className="truncate font-mono text-[11px] text-muted"
            >
              {settings.npub}
            </span>
            <CopyButton text={settings.npub} label="Copy npub" />
          </span>
        </Row>
      ) : null}

      <Block
        label={settings.keyConfigured ? "Replace the key" : "Your secret key"}
        note={
          settings.keyConfigured
            ? "Pasting a new key replaces the stored one immediately."
            : "Paste an nsec1… string or 64 hex characters. No key yet? Generate one below."
        }
      >
        <div className="flex items-center gap-2">
          <Input
            type="password"
            spellCheck={false}
            autoComplete="off"
            aria-label="Nostr secret key"
            placeholder={
              settings.keyConfigured ? "Replace the stored key" : "Paste an nsec"
            }
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              void save();
            }}
            className="flex-1 font-mono placeholder:font-sans"
          />
          <Button
            variant="secondary"
            disabled={draft.trim() === ""}
            onClick={() => void save()}
          >
            Save
          </Button>
        </div>
      </Block>

      {!settings.keyConfigured ? (
        <Row
          label="Generate a new key"
          note="Mints a fresh identity on this Mac. The secret is shown once, right here, so you can back it up."
        >
          <Button
            variant="secondary"
            onClick={() => {
              void generateNostrKey().then((nsec) => {
                if (nsec !== null) setRevealedNsec(nsec);
              });
            }}
          >
            Generate
          </Button>
        </Row>
      ) : null}

      {revealedNsec !== null ? (
        <Block
          label="Back up this secret key now"
          note="This is the ONLY time it will be shown. Anyone holding it is you on Nostr; store it in a password manager."
        >
          <div className="flex items-center gap-2 rounded-lg border border-warn/40 bg-warn/8 p-2">
            <TriangleAlert className="size-3.5 shrink-0 text-warn" aria-hidden="true" />
            <span className="min-w-0 flex-1 font-mono text-[11px] break-all text-text select-text">
              {revealedNsec}
            </span>
            <CopyButton text={revealedNsec} label="Copy nsec" />
            <Button variant="secondary" size="sm" onClick={() => setRevealedNsec(null)}>
              I saved it
            </Button>
          </div>
        </Block>
      ) : null}

      {settings.keyConfigured ? (
        <Row
          label="Remove the key"
          note="window.nostr stops working everywhere. The key is erased from this Mac — if it isn't backed up, it is gone."
        >
          <Button
            variant="danger"
            onClick={() => {
              if (!confirmingRemove) {
                setConfirmingRemove(true);
                window.setTimeout(() => setConfirmingRemove(false), 4000);
                return;
              }
              setConfirmingRemove(false);
              void removeNostrKey();
            }}
          >
            {confirmingRemove ? "Click again to confirm" : "Remove"}
          </Button>
        </Row>
      ) : null}
    </Group>
  );
}

/* -------------------------------- relays -------------------------------- */

function RelaysGroup({ settings }: { settings: NostrSettingsInfo }) {
  const setNostrRelays = useSumaStore((s) => s.setNostrRelays);
  const [draft, setDraft] = useState("");
  const relays = settings.relays;
  const urls = Object.keys(relays);

  const add = (): void => {
    let parsed: URL;
    try {
      parsed = new URL(draft.trim());
    } catch {
      return;
    }
    if (parsed.protocol !== "wss:" && parsed.protocol !== "ws:") return;
    void setNostrRelays({
      ...relays,
      [parsed.href]: { read: true, write: true },
    });
    setDraft("");
  };

  return (
    <Group
      title="Relays"
      note="What sites get when they ask window.nostr.getRelays() — a hint about where to publish and find your notes."
    >
      {urls.map((url) => {
        const entry = relays[url] ?? { read: true, write: true };
        return (
          <Row key={url} label={url.replace(/\/$/, "")}>
            <span className="flex items-center gap-3">
              <span className="flex items-center gap-1.5 text-[11px] text-faint">
                Read
                <Switch
                  checked={entry.read}
                  label={`Read from ${url}`}
                  onChange={(read) =>
                    void setNostrRelays({ ...relays, [url]: { ...entry, read } })
                  }
                />
              </span>
              <span className="flex items-center gap-1.5 text-[11px] text-faint">
                Write
                <Switch
                  checked={entry.write}
                  label={`Write to ${url}`}
                  onChange={(write) =>
                    void setNostrRelays({ ...relays, [url]: { ...entry, write } })
                  }
                />
              </span>
              <Button
                variant="ghost"
                size="icon"
                title="Remove relay"
                aria-label={`Remove ${url}`}
                onClick={() => {
                  const next = { ...relays };
                  delete next[url];
                  void setNostrRelays(next);
                }}
              >
                <X className="size-3" aria-hidden="true" />
              </Button>
            </span>
          </Row>
        );
      })}
      <Block>
        <div className="flex items-center gap-2">
          <Input
            spellCheck={false}
            autoComplete="off"
            aria-label="Add relay"
            placeholder="wss://relay.example.com"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              add();
            }}
            className="flex-1 font-mono placeholder:font-sans"
          />
          <Button variant="secondary" disabled={draft.trim() === ""} onClick={add}>
            Add
          </Button>
        </div>
      </Block>
    </Group>
  );
}

/* ---------------------------- Buzz workspace ----------------------------- */

/** One agent tile: avatar (image or glyph), name, truncated npub. */
function AgentTile({ agent }: { agent: BuzzAgent }) {
  const [imageFailed, setImageFailed] = useState(false);
  useEffect(() => setImageFailed(false), [agent.avatarUrl]);
  const showImage = agent.avatarUrl !== null && !imageFailed;
  return (
    <div className="flex w-[92px] flex-col items-center gap-1.5">
      {showImage ? (
        <img
          src={agent.avatarUrl ?? undefined}
          alt=""
          loading="lazy"
          draggable={false}
          onError={() => setImageFailed(true)}
          className="size-14 rounded-full border border-hairline bg-ink/8 object-cover"
        />
      ) : (
        // No avatar configured (or it failed to load): the agent's initial
        // in an accent tile, so the grid never shows a broken image.
        <span className="grid size-14 place-items-center rounded-full border border-hairline bg-accent/12 text-[20px] font-semibold text-accent select-none">
          {agent.name.trim().charAt(0).toUpperCase() || "?"}
        </span>
      )}
      <span
        title={agent.name}
        className="w-full truncate text-center text-[11.5px] font-medium text-text"
      >
        {agent.name}
      </span>
      <button
        type="button"
        title={`${agent.npub} — click to copy`}
        onClick={() => void navigator.clipboard.writeText(agent.npub)}
        className="w-full cursor-pointer truncate text-center font-mono text-[9.5px] text-faint outline-none hover:text-muted focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        {truncateNpub(agent.npub)}
      </button>
    </div>
  );
}

/**
 * The Buzz workspace group: the relay URL, and the roster it answers with.
 * The fetch authenticates with the signing key above — the same key is the
 * workspace's owner identity, which is what makes this a two-line setup.
 */
function BuzzGroup({ settings }: { settings: NostrSettingsInfo }) {
  const buzz = useSumaStore((s) => s.buzzAgents);
  const setBuzzRelay = useSumaStore((s) => s.setBuzzRelay);
  const loadBuzzAgents = useSumaStore((s) => s.loadBuzzAgents);
  const configured = settings.buzzRelayUrl;
  const [draft, setDraft] = useState(configured ?? "");
  // A URL saved elsewhere (another window, a fresh hydrate) refreshes an
  // untouched field but never overwrites what the user is mid-typing.
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (!touched) setDraft(configured ?? "");
  }, [configured, touched]);

  const save = async (): Promise<void> => {
    if (await setBuzzRelay(draft)) setTouched(false);
  };

  // First look at the page with a relay configured: pull the roster (the
  // invoke starts a fetch when nothing has been fetched yet).
  useEffect(() => {
    if (configured !== null && buzz.status === "idle") void loadBuzzAgents();
  }, [configured, buzz.status, loadBuzzAgents]);

  const loading = buzz.status === "loading";
  return (
    <Group
      title="Buzz workspace"
      note="Buzz (github.com/block/buzz) is a workspace where humans and AI agents share rooms. Point Suma at your relay and the agents you've set up appear here — signed in with the key above."
    >
      <Block label="Relay URL" note="wss:// (or ws:// for a local relay). Leave empty to disconnect.">
        <div className="flex items-center gap-2">
          <Input
            spellCheck={false}
            autoComplete="off"
            aria-label="Buzz relay URL"
            placeholder="wss://buzz.example.com"
            value={draft}
            onChange={(e) => {
              setTouched(true);
              setDraft(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              void save();
            }}
            className="flex-1 font-mono placeholder:font-sans"
          />
          <Button
            variant="secondary"
            disabled={!touched || draft.trim() === (configured ?? "")}
            onClick={() => void save()}
          >
            Save
          </Button>
          {configured !== null ? (
            <Button
              variant="ghost"
              size="icon"
              title="Refresh agents"
              aria-label="Refresh Buzz agents"
              disabled={loading}
              onClick={() => void loadBuzzAgents(true)}
            >
              {loading ? (
                <LoaderCircle className="size-3 animate-spin" aria-hidden="true" />
              ) : (
                <RefreshCw className="size-3" aria-hidden="true" />
              )}
            </Button>
          ) : null}
        </div>
      </Block>

      {configured !== null ? (
        <Block
          label="Agents"
          note={
            buzz.status === "ready"
              ? buzz.agents.length === 0
                ? "The relay answered, but no agents are set up on it yet."
                : `${String(buzz.agents.length)} agent${buzz.agents.length === 1 ? "" : "s"} on this workspace.`
              : undefined
          }
        >
          {buzz.status === "error" ? (
            <div className="flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/5 p-2 text-[11.5px] leading-snug text-text">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-danger" aria-hidden="true" />
              <span className="min-w-0">{buzz.error}</span>
            </div>
          ) : buzz.agents.length > 0 ? (
            <div className="flex flex-wrap gap-x-3 gap-y-4 pt-1">
              {buzz.agents.map((agent) => (
                <AgentTile key={agent.pubkey} agent={agent} />
              ))}
            </div>
          ) : loading ? (
            <div className="flex items-center gap-2 py-2 text-[11.5px] text-faint">
              <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
              Asking the relay for its agents…
            </div>
          ) : (
            <div className="flex items-center gap-2 py-2 text-[11.5px] text-faint">
              <Bot className="size-3.5" aria-hidden="true" />
              No agents yet.
            </div>
          )}
        </Block>
      ) : null}
    </Group>
  );
}

/* --------------------------- site permissions ---------------------------- */

/** The methods a site policy covers besides signing, with page labels. */
const METHOD_ROWS: Array<{
  method: Exclude<NostrMethod, "signEvent">;
  label: string;
  note?: string;
}> = [
  { method: "getPublicKey", label: "Read public key" },
  { method: "getRelays", label: "Read relay list" },
  { method: "nip04.encrypt", label: "Encrypt (NIP-04)" },
  { method: "nip04.decrypt", label: "Decrypt (NIP-04)" },
  { method: "nip44.encrypt", label: "Encrypt (NIP-44)" },
  { method: "nip44.decrypt", label: "Decrypt (NIP-44)" },
];

/** Kinds offered in the add-rule picker: the labeled ones, common first. */
const KIND_SUGGESTIONS = Object.keys(NOSTR_KIND_LABELS).map(Number);

function SiteCard({ policy }: { policy: NostrSitePolicy }) {
  const setNostrSitePolicy = useSumaStore((s) => s.setNostrSitePolicy);
  const removeNostrSitePolicy = useSumaStore((s) => s.removeNostrSitePolicy);
  const [kindDraft, setKindDraft] = useState("");
  const [kindChoice, setKindChoice] = useState<NostrPermissionChoice>("allow");

  const kindRules = Object.entries(policy.kinds).sort(
    ([a], [b]) => Number(a) - Number(b),
  );

  const addKindRule = (): void => {
    const kind = kindDraft.trim();
    if (!/^\d+$/.test(kind)) return;
    void setNostrSitePolicy(policy.host, { kinds: { [kind]: kindChoice } });
    setKindDraft("");
  };

  return (
    <Group title={policy.host}>
      {kindRules.map(([kind, choice]) => (
        <Row
          key={kind}
          label={`Sign ${nostrKindLabel(Number(kind))}s`}
          note={`kind ${kind}`}
        >
          <span className="flex items-center gap-1">
            <ChoiceSelect
              value={choice}
              ariaLabel={`Signing rule for kind ${kind} on ${policy.host}`}
              onChange={(next) =>
                void setNostrSitePolicy(policy.host, { kinds: { [kind]: next } })
              }
            />
            <Button
              variant="ghost"
              size="icon"
              title="Remove this rule"
              aria-label={`Remove the kind ${kind} rule`}
              onClick={() =>
                void setNostrSitePolicy(policy.host, { kinds: { [kind]: null } })
              }
            >
              <X className="size-3" aria-hidden="true" />
            </Button>
          </span>
        </Row>
      ))}

      <Block note="Add a per-kind signing rule — e.g. allow follow-list updates (kind 3) while still asking for notes (kind 1).">
        <div className="flex items-center gap-2">
          <Input
            spellCheck={false}
            autoComplete="off"
            aria-label="Event kind number"
            placeholder="Kind, e.g. 3"
            value={kindDraft}
            onChange={(e) => setKindDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              addKindRule();
            }}
            className="w-[110px]"
            list={`nostr-kinds-${policy.host}`}
          />
          <datalist id={`nostr-kinds-${policy.host}`}>
            {KIND_SUGGESTIONS.map((kind) => (
              <option key={kind} value={kind} label={nostrKindLabel(kind)} />
            ))}
          </datalist>
          <ChoiceSelect
            value={kindChoice}
            ariaLabel="Rule for the new kind"
            onChange={setKindChoice}
          />
          <Button
            variant="secondary"
            disabled={!/^\d+$/.test(kindDraft.trim())}
            onClick={addKindRule}
          >
            <Plus className="size-3" aria-hidden="true" />
            Add
          </Button>
        </div>
      </Block>

      <Row
        label="Sign anything else"
        note="Kinds without a rule above fall back to this."
      >
        <ChoiceSelect
          value={policy.signDefault}
          ariaLabel={`Default signing rule for ${policy.host}`}
          onChange={(next) =>
            void setNostrSitePolicy(policy.host, { signDefault: next })
          }
        />
      </Row>

      {METHOD_ROWS.map(({ method, label }) => (
        <Row key={method} label={label}>
          <ChoiceSelect
            value={policy.methods[method] ?? "ask"}
            ariaLabel={`${label} rule for ${policy.host}`}
            onChange={(next) =>
              void setNostrSitePolicy(policy.host, { methods: { [method]: next } })
            }
          />
        </Row>
      ))}

      <Row
        label="Forget this site"
        note="Drops every rule above; the site goes back to asking for everything."
      >
        <Button
          variant="danger"
          onClick={() => void removeNostrSitePolicy(policy.host)}
        >
          Forget
        </Button>
      </Row>
    </Group>
  );
}

function AddSiteBlock() {
  const setNostrSitePolicy = useSumaStore((s) => s.setNostrSitePolicy);
  const [draft, setDraft] = useState("");

  const add = (): void => {
    // Accept a bare host or a pasted URL; policies key on the hostname.
    const raw = draft.trim().toLowerCase();
    if (raw === "") return;
    let host = raw;
    try {
      host = new URL(raw.includes("://") ? raw : `https://${raw}`).hostname;
    } catch {
      return;
    }
    if (host === "") return;
    void setNostrSitePolicy(host, {});
    setDraft("");
  };

  return (
    <Group
      title="Site permissions"
      note="Every site starts at “ask for everything”. Rules are also written when you tick “Remember” on an approval — this is where they live."
    >
      <Block>
        <div className="flex items-center gap-2">
          <Input
            spellCheck={false}
            autoComplete="off"
            aria-label="Add a site"
            placeholder="primal.net"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              add();
            }}
            className="flex-1 font-mono placeholder:font-sans"
          />
          <Button variant="secondary" disabled={draft.trim() === ""} onClick={add}>
            <Plus className="size-3" aria-hidden="true" />
            Add site
          </Button>
        </div>
      </Block>
    </Group>
  );
}

/* -------------------------------- the page ------------------------------- */

export function NostrPage() {
  const settings = useSumaStore((s) => s.nostrSettings);
  const refreshNostrSettings = useSumaStore((s) => s.refreshNostrSettings);

  useEffect(() => {
    // Live pushes (nostr:settingsChanged) keep it fresh after this.
    void refreshNostrSettings();
  }, [refreshNostrSettings]);

  if (settings === null) {
    return (
      <Page
        title="Nostr"
        description="Sign in to Nostr apps with a key that never leaves this Mac."
      >
        <Group>
          <Block>
            <p className="text-[11.5px] text-faint">Loading…</p>
          </Block>
        </Group>
      </Page>
    );
  }

  return (
    <Page
      title="Nostr"
      description="Suma acts as your NIP-07 signer: sites call window.nostr, and your key answers — with your rules deciding what needs a prompt."
    >
      <IdentityGroup settings={settings} />
      <RelaysGroup settings={settings} />
      <BuzzGroup settings={settings} />
      <AddSiteBlock />
      {settings.policies.map((policy) => (
        <SiteCard key={policy.host} policy={policy} />
      ))}
    </Page>
  );
}
