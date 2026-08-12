/**
 * The `suma://settings/privacy/*` menu: sign-in, browsing history, the
 * identity IP, and the audit trail.
 *
 * These four were scattered across the old settings modal and two overlays it
 * launched. They belong together — each one is an answer to "what leaves this
 * Mac, and who can see it" — and grouping them is most of the reason the
 * sidebar exists.
 */

import { useEffect } from "react";
import type { PasskeyStatus } from "../../../../../shared/ipc";
import { cn } from "../../../lib/cn";
import { agoLabel } from "../../../lib/format";
import { useSumaStore } from "../../../store";
import { EgressControls } from "../../EgressControls";
import { Button } from "../../ui/button";
import { Switch } from "../../ui/switch";
import { Block, Group, Page, Row } from "../parts";

const PASSKEY_BADGE: Record<PasskeyStatus["support"], string> = {
  available: "Ready",
  "unsigned-build": "Dev build",
  "unsupported-platform": "Unavailable",
};

export function SignInPage() {
  const passkeyStatus = useSumaStore((s) => s.passkeyStatus);
  const credentialStatus = useSumaStore((s) => s.credentialStatus);
  const refreshCredentialStatus = useSumaStore((s) => s.refreshCredentialStatus);

  useEffect(() => {
    void refreshCredentialStatus();
  }, [refreshCredentialStatus]);

  return (
    <Page
      title="Sign-in & passkeys"
      description="How Suma authenticates you, and how it fills logins for the sites you visit."
    >
      <Group title="Passkeys">
        <Row label="Touch ID passkeys" note={passkeyStatus.detail}>
          <span
            className={cn(
              "shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-medium",
              passkeyStatus.support === "available" ? "bg-ok/15 text-ok" : "bg-warn/15 text-warn",
            )}
          >
            {PASSKEY_BADGE[passkeyStatus.support]}
          </span>
        </Row>
        <Row
          label="Site sign-in windows"
          note="A sign-in window a site opens runs in that space's cookie jar, so the session lands where the tab can actually use it — never in a separate profile you then have to sign in to twice."
        />
      </Group>

      <Group title="Password manager">
        <Row
          label={credentialStatus.provider === "1password-cli" ? "1Password CLI" : "No provider"}
          note={
            credentialStatus.detail ??
            "Suma fills logins through a provider you already trust; it never stores site passwords itself."
          }
        >
          <span
            className={cn(
              "shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-medium",
              credentialStatus.available ? "bg-ok/15 text-ok" : "bg-ink/8 text-faint",
            )}
          >
            {credentialStatus.available ? "Connected" : "Not detected"}
          </span>
        </Row>
      </Group>
    </Page>
  );
}

export function HistoryPage() {
  const settings = useSumaStore((s) => s.settings);
  const updateSettings = useSumaStore((s) => s.updateSettings);
  const clearHistory = useSumaStore((s) => s.clearHistory);

  return (
    <Page
      title="Browsing history"
      description="History is always kept on this Mac. Whether it also travels to your other Macs is a separate, off-by-default choice."
    >
      <Group>
        <Row
          label="Sync history to my other Macs"
          note="Off by default. When on, NEW visits sync sealed under your workspace key — the server never sees a URL. Visits from before you turned it on stay on the Mac that browsed them."
        >
          <Switch
            checked={settings.historySyncEnabled}
            label="History sync"
            onChange={(v) => void updateSettings({ historySyncEnabled: v })}
          />
        </Row>
        <Row
          label="Clear browsing history"
          note="Removes history on this Mac. Visits that were synced are deleted on every device."
        >
          <Button variant="secondary" onClick={() => void clearHistory()}>
            Clear
          </Button>
        </Row>
      </Group>
    </Page>
  );
}

export function EgressPage() {
  return (
    <Page
      title="Identity IP"
      description="Which spaces browse from your stable Suma IP, and which go direct from this Mac."
    >
      <Group>
        <Block>
          <EgressControls />
        </Block>
      </Group>
    </Page>
  );
}

export function AuditPage() {
  const audit = useSumaStore((s) => s.audit);
  const auditLoaded = useSumaStore((s) => s.auditLoaded);
  const auth = useSumaStore((s) => s.auth);
  const refreshAudit = useSumaStore((s) => s.refreshAudit);

  useEffect(() => {
    void refreshAudit();
  }, [refreshAudit]);

  // Local-only mode has no audit trail — it lives on the control plane — and
  // says so instead of showing an empty list that reads like a bug.
  const localOnly = auth.state === "unenrolled" && auth.controlUrl === null;

  return (
    <Page
      title="Audit trail"
      description="Every enrollment, revocation, key change, and machine transition on your account, recorded by the control plane (§8.7)."
    >
      <Group>
        {localOnly ? (
          <Block>
            <p className="py-4 text-center text-[12px] leading-relaxed text-faint">
              The audit trail is recorded by the control plane. This Mac is running local-only —
              set up Suma to get an account history.
            </p>
          </Block>
        ) : !auditLoaded ? (
          <Block>
            <p className="py-4 text-center text-[12px] text-faint">Loading audit trail…</p>
          </Block>
        ) : audit.length === 0 ? (
          <Block>
            <p className="py-4 text-center text-[12px] text-faint">No audit events yet.</p>
          </Block>
        ) : (
          audit.map((entry) => (
            <Block key={entry.id}>
              <p className="text-[12.5px] leading-snug text-text">{entry.summary}</p>
              <p className="mt-1 font-mono text-[10px] text-faint">
                {agoLabel(entry.createdAtMs)} · {entry.type} ·{" "}
                {entry.actorDeviceId === null
                  ? "Suma control"
                  : `device ${entry.actorDeviceId.slice(0, 8)}`}
              </p>
            </Block>
          ))
        )}
      </Group>
    </Page>
  );
}
