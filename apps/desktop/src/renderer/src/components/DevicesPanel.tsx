import { useState } from "react";
import { Laptop, Pencil, Trash2 } from "lucide-react";
import type {
  ConnectedDeviceInfo,
  RevocationReceipt,
} from "../../../shared/ipc";
import { cn } from "../lib/cn";
import { agoLabel } from "../lib/format";
import { useSumaStore } from "../store";
import { Input } from "./ui/input";

function Receipt({
  receipt,
  onDone,
}: {
  receipt: RevocationReceipt;
  onDone: () => void;
}) {
  const createTab = useSumaStore((s) => s.createTab);
  const setOverlay = useSumaStore((s) => s.setOverlay);

  return (
    <div className="rounded-xl border border-hairline bg-ink/3 px-3.5 py-3">
      <p className="text-[13px] font-semibold text-text">
        Device revoked —{" "}
        <span className="font-mono text-[11.5px]">{receipt.deviceId}</span>
      </p>
      <ul className="mt-2 flex flex-col gap-1 text-[11.5px] leading-snug text-muted">
        {receipt.stoppedFutureAccess ? (
          <li className="flex gap-1.5">
            <span className="text-ok">✓</span> Future Suma access stopped —
            certs and sync sessions are dead.
          </li>
        ) : null}
        {receipt.purgeOnReconnect ? (
          <li className="flex gap-1.5">
            <span className="text-ok">✓</span> Suma data on that Mac will be
            purged if it ever reconnects.
          </li>
        ) : null}
        {receipt.cannotInvalidateThirdPartySessions ? (
          <li className="flex gap-1.5 text-warn">
            <span>!</span> We stopped future Suma access but cannot end
            sessions already on that Mac. Log out at each site below.
          </li>
        ) : null}
      </ul>

      {receipt.affectedOrigins.length > 0 ? (
        <div className="mt-2.5 flex flex-col gap-1 border-t border-hairline pt-2.5">
          {receipt.affectedOrigins.map((origin) => (
            <div key={origin.domain} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-[12px] text-text">
                {origin.label}{" "}
                <span className="text-faint">· {origin.domain}</span>
              </span>
              {origin.remoteLogoutUrl !== undefined ? (
                <button
                  type="button"
                  onClick={() => {
                    const url = origin.remoteLogoutUrl;
                    if (url !== undefined) void createTab(url);
                    setOverlay("none");
                  }}
                  className="shrink-0 cursor-pointer rounded-md bg-accent/15 px-2 py-0.5 text-[10.5px] font-medium text-accent hover:bg-accent/25"
                >
                  Log out remotely
                </button>
              ) : (
                <span className="shrink-0 text-[10.5px] text-faint">
                  log out on the site
                </span>
              )}
            </div>
          ))}
        </div>
      ) : null}

      <button
        type="button"
        onClick={onDone}
        className="mt-3 w-full cursor-pointer rounded-lg bg-ink/6 px-3 py-1.5 text-[12px] text-text hover:bg-ink/10"
      >
        Done
      </button>
    </div>
  );
}

/**
 * Enrolled-device list with the §8.2 honest revocation contract: revoking
 * stops future Suma access ≤ 60 s but cannot invalidate third-party
 * sessions already on that Mac — the receipt says so, verbatim.
 */
/**
 * "Link another device" (§8.2 second-device flow): mints a single-use code
 * this account's next Mac types into its onboarding wizard. The code is a
 * credential while it lives — shown here once, never stored.
 */
function LinkDevice() {
  const auth = useSumaStore((s) => s.auth);
  const mintEnrollmentCode = useSumaStore((s) => s.mintEnrollmentCode);
  const pushToast = useSumaStore((s) => s.pushToast);
  const [minting, setMinting] = useState(false);
  const [code, setCode] = useState<string | null>(null);

  if (auth.state !== "enrolled") return null;

  const mint = async () => {
    setMinting(true);
    const out = await mintEnrollmentCode();
    setMinting(false);
    if (out !== undefined) setCode(out.code);
  };

  return (
    <div className="mt-2 border-t border-hairline pt-2.5">
      {code === null ? (
        <button
          type="button"
          disabled={minting}
          onClick={() => void mint()}
          className="cursor-pointer rounded-md bg-accent/15 px-2.5 py-1 text-[11.5px] font-medium text-accent hover:bg-accent/25 disabled:cursor-default disabled:opacity-50"
        >
          {minting ? "Minting code…" : "Link another device"}
        </button>
      ) : (
        <div className="flex flex-col gap-1.5">
          <p className="text-[11.5px] text-muted">
            On the new Mac, choose{" "}
            <span className="text-text">“Link this Mac with a code”</span>{" "}
            during setup and enter:
          </p>
          <div className="flex items-center gap-2">
            <span className="rounded-md bg-ink/6 px-2.5 py-1 font-mono text-[13px] tracking-wider text-text">
              {code}
            </span>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard
                  .writeText(code)
                  .then(() => pushToast("Code copied", "success"))
                  .catch(() =>
                    pushToast(
                      "Couldn't copy — select the code manually",
                      "error",
                    ),
                  );
              }}
              className="cursor-pointer rounded-md bg-ink/6 px-2 py-1 text-[11px] text-muted hover:bg-ink/10"
            >
              Copy
            </button>
            <button
              type="button"
              onClick={() => setCode(null)}
              className="cursor-pointer rounded-md bg-ink/6 px-2 py-1 text-[11px] text-muted hover:bg-ink/10"
            >
              Done
            </button>
          </div>
          <p className="text-[10.5px] text-faint">
            Single-use, expires in 10 minutes.
          </p>
        </div>
      )}
    </div>
  );
}

function shortDeviceId(deviceId: string): string {
  return deviceId.slice(0, 8);
}

function statusLabel(device: ConnectedDeviceInfo): string {
  if (device.revoked) return "Access revoked";
  if (device.online) return "Online now";
  return device.lastSeenMs > 0
    ? `Last seen ${agoLabel(device.lastSeenMs)}`
    : "Not connected yet";
}

function DeviceGlyph({ device }: { device: ConnectedDeviceInfo }) {
  return (
    <span className="relative grid size-9 shrink-0 place-items-center rounded-[11px] border border-hairline bg-gradient-to-b from-ink/[0.07] to-ink/[0.025] text-muted shadow-sm">
      <Laptop className="size-[17px]" aria-hidden="true" />
      <span
        aria-label={device.online ? "Online" : "Offline"}
        className={cn(
          "absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full border-2 border-raised",
          device.online ? "bg-ok shadow-[0_0_6px_var(--color-ok)]" : "bg-faint",
        )}
      />
    </span>
  );
}

function DeviceRow({
  device,
  displayName,
  busy,
  confirming,
  editing,
  draftName,
  onDraftName,
  onEdit,
  onCancelEdit,
  onSaveName,
  onConfirm,
  onCancelConfirm,
  onRevoke,
  onCopyId,
}: {
  device: ConnectedDeviceInfo;
  displayName: string;
  busy: boolean;
  confirming: boolean;
  editing: boolean;
  draftName: string;
  onDraftName: (name: string) => void;
  onEdit: () => void;
  onCancelEdit: () => void;
  onSaveName: () => void;
  onConfirm: () => void;
  onCancelConfirm: () => void;
  onRevoke: () => void;
  onCopyId: () => void;
}) {
  return (
    <div
      data-testid={`device-row-${device.deviceId}`}
      className={cn(
        "rounded-xl border px-3 py-2.5 transition-colors",
        device.revoked
          ? "border-hairline bg-ink/[0.015] opacity-70"
          : "border-hairline bg-ink/[0.025] hover:bg-ink/[0.04]",
      )}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <DeviceGlyph device={device} />
        <div className="min-w-0 flex-1">
          {editing ? (
            <div className="flex items-center gap-1.5">
              <Input
                autoFocus
                aria-label={`Rename ${device.name}`}
                value={draftName}
                maxLength={200}
                onChange={(event) => onDraftName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") onSaveName();
                  if (event.key === "Escape") onCancelEdit();
                }}
                className="flex-1"
              />
              <button
                type="button"
                disabled={busy || draftName.trim().length === 0}
                onClick={onSaveName}
                className="cursor-pointer rounded-md bg-accent px-2 py-1 text-[10.5px] font-medium text-white hover:bg-accent/85 disabled:cursor-default disabled:opacity-40"
              >
                Save
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={onCancelEdit}
                className="cursor-pointer rounded-md px-1.5 py-1 text-[10.5px] text-faint hover:bg-ink/8 hover:text-text"
              >
                Cancel
              </button>
            </div>
          ) : (
            <p className="flex min-w-0 items-center gap-1.5 text-[12.5px] font-medium text-text">
              <span className="truncate">{displayName}</span>
              {device.isThisDevice ? (
                <span className="shrink-0 rounded-full bg-accent/15 px-1.5 py-px text-[9px] font-semibold tracking-wide text-accent uppercase">
                  This Mac
                </span>
              ) : null}
            </p>
          )}
          {!editing ? (
            <p className="mt-0.5 flex items-center gap-1 text-[10.5px] text-faint">
              <span>{device.platform}</span>
              <span aria-hidden="true">·</span>
              <span className={device.online ? "text-ok" : ""}>
                {statusLabel(device)}
              </span>
              <span aria-hidden="true">·</span>
              <button
                type="button"
                title={`Copy full device ID: ${device.deviceId}`}
                onClick={onCopyId}
                className="cursor-pointer font-mono text-[9.5px] hover:text-muted"
              >
                ID {shortDeviceId(device.deviceId)}…
              </button>
            </p>
          ) : null}
        </div>

        {!editing && !device.revoked ? (
          <div className="flex shrink-0 items-center gap-1">
            {device.canRename ? (
              <button
                type="button"
                disabled={busy}
                aria-label={`Rename ${device.name}`}
                title="Rename device"
                onClick={onEdit}
                className="grid size-6 cursor-pointer place-items-center rounded-md text-faint hover:bg-ink/8 hover:text-text disabled:cursor-default disabled:opacity-40"
              >
                <Pencil className="size-2.5" aria-hidden="true" />
              </button>
            ) : null}
            {!device.isThisDevice ? (
              confirming ? (
                <span className="flex items-center gap-1">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={onRevoke}
                    className="cursor-pointer rounded-md bg-danger/20 px-2 py-1 text-[10.5px] font-medium text-danger hover:bg-danger/30 disabled:cursor-default disabled:opacity-50"
                  >
                    {busy ? "Revoking…" : "Confirm"}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={onCancelConfirm}
                    className="cursor-pointer rounded-md px-1.5 py-1 text-[10.5px] text-faint hover:bg-ink/8 hover:text-text"
                  >
                    Cancel
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  aria-label={`Revoke ${device.name}`}
                  title="Stop this device's future Suma access"
                  onClick={onConfirm}
                  className="grid size-6 cursor-pointer place-items-center rounded-md text-faint hover:bg-danger/15 hover:text-danger"
                >
                  <Trash2 className="size-2.5" aria-hidden="true" />
                </button>
              )
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function DevicesPanel() {
  const devices = useSumaStore((s) => s.devices);
  const revokeDevice = useSumaStore((s) => s.revokeDevice);
  const renameDevice = useSumaStore((s) => s.renameDevice);
  const pushToast = useSumaStore((s) => s.pushToast);

  const [confirming, setConfirming] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<RevocationReceipt | null>(null);

  const revoke = async (deviceId: string) => {
    setBusy(deviceId);
    const result = await revokeDevice(deviceId);
    setBusy(null);
    setConfirming(null);
    if (result !== undefined) setReceipt(result);
  };

  const saveName = async (deviceId: string) => {
    const name = draftName.trim();
    if (name.length === 0) return;
    setBusy(deviceId);
    const renamed = await renameDevice(deviceId, name);
    setBusy(null);
    if (!renamed) return;
    setEditing(null);
    pushToast(`Device renamed to ${name}`, "success");
  };

  const nameCounts = new Map<string, number>();
  for (const device of devices)
    nameCounts.set(device.name, (nameCounts.get(device.name) ?? 0) + 1);
  const activeDevices = devices.filter((device) => !device.revoked);
  const revokedDevices = devices.filter((device) => device.revoked);

  if (receipt !== null) {
    return <Receipt receipt={receipt} onDone={() => setReceipt(null)} />;
  }

  if (activeDevices.length === 0) {
    return (
      <>
        <p className="text-[12px] text-faint">No devices enrolled yet.</p>
        <LinkDevice />
      </>
    );
  }

  return (
    <>
      <div className="flex flex-col gap-1.5">
        {activeDevices.map((device) => (
          <DeviceRow
            key={device.deviceId}
            device={device}
            displayName={
              (nameCounts.get(device.name) ?? 0) > 1
                ? `${device.name} · ${shortDeviceId(device.deviceId)}`
                : device.name
            }
            busy={busy === device.deviceId}
            confirming={confirming === device.deviceId}
            editing={editing === device.deviceId}
            draftName={draftName}
            onDraftName={setDraftName}
            onEdit={() => {
              setEditing(device.deviceId);
              setDraftName(device.name);
              setConfirming(null);
            }}
            onCancelEdit={() => setEditing(null)}
            onSaveName={() => void saveName(device.deviceId)}
            onConfirm={() => {
              setConfirming(device.deviceId);
              setEditing(null);
            }}
            onCancelConfirm={() => setConfirming(null)}
            onRevoke={() => void revoke(device.deviceId)}
            onCopyId={() => {
              void navigator.clipboard
                .writeText(device.deviceId)
                .then(() => pushToast("Device ID copied", "success"))
                .catch(() => pushToast("Couldn't copy the device ID", "error"));
            }}
          />
        ))}
      </div>
      <p className="mt-1.5 text-[10.5px] leading-snug text-faint">
        Revoking stops future Suma access within a minute. It cannot end
        third-party sessions already on that Mac — the receipt lists where to
        log out remotely.
      </p>
      {revokedDevices.length > 0 ? (
        <details className="mt-2 border-t border-hairline pt-2">
          <summary className="cursor-pointer text-[10.5px] font-medium text-faint hover:text-muted">
            Revoked devices ({revokedDevices.length})
          </summary>
          <div className="mt-1.5 flex flex-col gap-1.5">
            {revokedDevices.map((device) => (
              <DeviceRow
                key={device.deviceId}
                device={device}
                displayName={device.name}
                busy={false}
                confirming={false}
                editing={false}
                draftName=""
                onDraftName={() => undefined}
                onEdit={() => undefined}
                onCancelEdit={() => undefined}
                onSaveName={() => undefined}
                onConfirm={() => undefined}
                onCancelConfirm={() => undefined}
                onRevoke={() => undefined}
                onCopyId={() =>
                  void navigator.clipboard.writeText(device.deviceId)
                }
              />
            ))}
          </div>
        </details>
      ) : null}
      <LinkDevice />
    </>
  );
}
