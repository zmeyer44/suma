/** The `suma://settings/account/*` menu: identity, devices, sync, recovery. */

import { useEffect, useState } from "react";
import { cn } from "../../../lib/cn";
import { agoLabel } from "../../../lib/format";
import { useSumaStore } from "../../../store";
import { DevicesPanel } from "../../DevicesPanel";
import { RecoveryPanel } from "../../RecoveryPanel";
import { Button } from "../../ui/button";
import { Block, Group, Page, Row } from "../parts";

/**
 * Sign out (§8.2). This is a LOCAL RESET, not a revocation: it erases the
 * account, keys, spaces, tabs, history, and every site cookie ON THIS MAC and
 * relaunches Suma at first run — while the account itself and the other
 * enrolled devices are untouched. The confirm step spells that out, because
 * nothing here comes back without the recovery code.
 */
function SignOutRow() {
  const signOut = useSumaStore((s) => s.signOut);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!confirming) {
    return (
      <Row
        label="Sign out of this Mac"
        note="Erases this Mac's Suma data and restarts at first run. Your account and other devices stay as they are."
      >
        <Button variant="secondary" onClick={() => setConfirming(true)}>
          Sign out
        </Button>
      </Row>
    );
  }

  return (
    <Block label="Sign out of this Mac">
      <p className="mt-1 mb-2.5 text-[11.5px] leading-relaxed text-warn">
        Signing out erases this Mac&rsquo;s copy of everything: your keys, spaces, tabs, history,
        and every site you&rsquo;re logged into. Without your recovery code it cannot be undone.
        Your account and your other Macs are unaffected — this Mac stays enrolled until you revoke
        it from one of them.
      </p>
      <span className="flex items-center gap-1.5">
        <Button
          variant="danger"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            // Resolves only if the relaunch never happens; the failure itself
            // surfaces as a toast from the store.
            void signOut().finally(() => setBusy(false));
          }}
        >
          {busy ? "Signing out…" : "Sign out and erase"}
        </Button>
        <Button variant="secondary" disabled={busy} onClick={() => setConfirming(false)}>
          Cancel
        </Button>
      </span>
    </Block>
  );
}

export function AccountPage() {
  const auth = useSumaStore((s) => s.auth);
  const openOnboarding = useSumaStore((s) => s.openOnboarding);
  const keyMode = useSumaStore((s) => s.settings.keyMode);
  const e2ee = keyMode === "e2ee";

  return (
    <Page
      title="Account"
      description="Who this Mac is signed in as, and which key holds your spaces."
    >
      <Group>
        {auth.state === "enrolled" ? (
          <Row
            label={auth.email ?? "Enrolled"}
            note={`${auth.deviceName ?? auth.suggestedDeviceName} · ${
              auth.credentialKind === "webauthn" ? "passkey" : "device key"
            } holds your space keys`}
          >
            <span className="rounded-full bg-ok/12 px-2 py-0.5 text-[10.5px] font-semibold text-ok">
              Enrolled
            </span>
          </Row>
        ) : (
          <Row
            label={auth.state === "signed-up" ? (auth.email ?? "Signed up") : "Not set up"}
            note={
              auth.state === "signed-up"
                ? "Account created — finish enrolling this Mac to sync."
                : "Browsing local-only. Set up Suma to sync spaces across your Macs."
            }
          >
            <Button variant="soft" onClick={openOnboarding}>
              {auth.state === "signed-up" ? "Finish setup" : "Set up Suma"}
            </Button>
          </Row>
        )}
        <Row
          label="Encryption"
          note={
            e2ee
              ? "End-to-end: only your enrolled devices hold the keys. The server stores sealed bytes it cannot read."
              : "Suma-managed keys. A visible security mode — never a silent downgrade."
          }
        >
          <span
            className={cn(
              "shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold tracking-wide uppercase",
              e2ee ? "bg-ok/15 text-ok" : "bg-warn/15 text-warn",
            )}
          >
            {e2ee ? "E2EE" : "Managed keys"}
          </span>
        </Row>
        {/* An unenrolled Mac has no account to leave — the "Set up Suma" row
            above is already its whole story. */}
        {auth.state === "unenrolled" ? null : <SignOutRow />}
      </Group>
    </Page>
  );
}

export function DevicesPage() {
  const refreshDevices = useSumaStore((s) => s.refreshDevices);

  useEffect(() => {
    void refreshDevices();
  }, [refreshDevices]);

  return (
    <Page
      title="Devices"
      description="Every Mac enrolled on your account. Revoking one stops its future access — read the receipt, it is honest about what revocation cannot undo."
    >
      <Group>
        <Block>
          <DevicesPanel />
        </Block>
      </Group>
    </Page>
  );
}

const CONNECTION_LABEL: Record<string, string> = {
  connected: "Connected",
  connecting: "Connecting…",
  offline: "Offline",
  paused: "Paused",
};

export function SyncPage() {
  const syncStatus = useSumaStore((s) => s.syncStatus);
  const workspaceSync = useSumaStore((s) => s.workspaceSync);
  const setOverlay = useSumaStore((s) => s.setOverlay);
  const ok = syncStatus.state === "connected";

  return (
    <Page
      title="Sync"
      description="The live connection to SessionHub, and the state of the workspace shared between your Macs."
    >
      <Group title="Connection">
        <Row
          label="SessionHub"
          note={
            syncStatus.queueDepth > 0
              ? `${syncStatus.queueDepth} change(s) queued locally — they flush when the connection is back.`
              : "Tabs, spaces, and focus converge over an encrypted realtime channel."
          }
        >
          <span
            className={cn(
              "shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-medium",
              ok ? "bg-ok/15 text-ok" : "bg-warn/15 text-warn",
            )}
          >
            {CONNECTION_LABEL[syncStatus.state] ?? syncStatus.state}
          </span>
        </Row>
        <Row
          label="Last converged"
          note="When this Mac and the canonical workspace last agreed."
        >
          <span className="text-[12px] text-muted">
            {syncStatus.lastConvergedMs === null
              ? "never"
              : agoLabel(syncStatus.lastConvergedMs)}
          </span>
        </Row>
      </Group>

      <Group title="Shared workspace">
        <Row
          label="Reconcile now"
          note={
            !workspaceSync.remoteReady
              ? "Waiting for a complete snapshot from SessionHub."
              : workspaceSync.pending
                ? "Local and canonical state differ — push this Mac's version, pull another's, or merge."
                : "This Mac matches the canonical workspace."
          }
        >
          <Button
            variant="soft"
            disabled={!workspaceSync.remoteReady || !workspaceSync.pending}
            onClick={() => setOverlay("workspace-sync")}
          >
            {workspaceSync.pending ? "Reconcile…" : "Up to date"}
          </Button>
        </Row>
      </Group>
    </Page>
  );
}

export function RecoveryPage() {
  return (
    <Page
      title="Recovery"
      description="Your offline recovery code is the only way back into your encrypted spaces when no enrolled device is left."
    >
      <Group>
        <Block>
          <RecoveryPanel />
        </Block>
      </Group>
    </Page>
  );
}
