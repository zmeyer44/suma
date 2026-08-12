import { useEffect, useMemo, useRef, useState } from "react";
import { Lock } from "lucide-react";
import type { CredentialItem } from "../../../shared/ipc";
import { cn } from "../lib/cn";
import { fuzzyFilter } from "../lib/fuzzy";
import { hostOf } from "../lib/url";
import { selectActiveTab, useSumaStore } from "../store";
import { Input } from "./ui/input";
import { Modal, ModalContent } from "./ui/modal";

/**
 * "Fill password" picker (§8.1 credential path): searches the external
 * provider (1Password CLI) for the active tab's host and fills the focused
 * login form. Secrets never touch the renderer — main brokers the fill.
 */
export function CredentialFill() {
  const open = useSumaStore((s) => s.overlay === "credentials");
  const setOverlay = useSumaStore((s) => s.setOverlay);
  const status = useSumaStore((s) => s.credentialStatus);
  const activeTab = useSumaStore(selectActiveTab);
  const refreshCredentialStatus = useSumaStore((s) => s.refreshCredentialStatus);
  const searchCredentials = useSumaStore((s) => s.searchCredentials);
  const fillCredential = useSumaStore((s) => s.fillCredential);
  const pushToast = useSumaStore((s) => s.pushToast);

  const host = activeTab !== null ? hostOf(activeTab.url) : "";

  const [items, setItems] = useState<CredentialItem[] | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [filling, setFilling] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelected(0);
    setItems(null);
    setFilling(false);
    void refreshCredentialStatus();
    inputRef.current?.focus();
  }, [open, refreshCredentialStatus]);

  useEffect(() => {
    if (!open || !status.available || host.length === 0) return;
    let stale = false;
    void searchCredentials(host).then((found) => {
      if (!stale) setItems(found);
    });
    return () => {
      stale = true;
    };
  }, [open, status.available, host, searchCredentials]);

  const filtered = useMemo(
    () =>
      items === null
        ? []
        : fuzzyFilter(items, query.trim(), (i) => `${i.title} ${i.username}`).slice(0, 8),
    [items, query],
  );

  useEffect(() => setSelected(0), [query, items]);

  const close = () => setOverlay("none");

  const pick = async (item: CredentialItem | undefined) => {
    if (item === undefined || activeTab === null || filling) return;
    setFilling(true);
    const ok = await fillCredential(activeTab.id, item.id);
    setFilling(false);
    pushToast(
      ok
        ? `Filled ${item.username} on ${host}`
        : `Couldn't fill ${host} — click the login form first, then retry`,
    );
    close();
  };

  const guidance =
    status.detail ??
    "No credential provider detected. Install the 1Password CLI (op) and sign in to enable one-keystroke fills.";

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!next) setOverlay("none");
      }}
    >
      <ModalContent
        title="Fill password"
        width={440}
        icon={
          <Lock className="size-3.5" aria-hidden="true" />
        }
      >
        <div className="flex shrink-0 items-center gap-2.5 border-b border-hairline px-4">
          <Input
            variant="bare"
            ref={inputRef}
            type="text"
            spellCheck={false}
            autoComplete="off"
            placeholder={host.length > 0 ? `Fill password for ${host}` : "Fill password"}
            aria-label="Filter logins"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSelected((i) => Math.min(i + 1, filtered.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setSelected((i) => Math.max(i - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                void pick(filtered[selected]);
              }
              // Escape falls through to the dialog's dismiss.
            }}
            className="h-11 w-full text-[13.5px]"
          />
          <kbd className="shrink-0 rounded-md border border-hairline bg-ink/4 px-1.5 py-0.5 text-[10px] text-faint">
            esc
          </kbd>
        </div>

        <div className="max-h-[280px] overflow-y-auto p-1.5">
          {!status.available ? (
            <p className="px-3 py-5 text-center text-[12px] leading-relaxed text-muted">{guidance}</p>
          ) : host.length === 0 ? (
            <p className="px-3 py-5 text-center text-[12px] text-faint">
              Open a tab with a login form first.
            </p>
          ) : items === null ? (
            <p className="px-3 py-5 text-center text-[12px] text-faint">Searching {host}…</p>
          ) : filtered.length === 0 ? (
            <p className="px-3 py-5 text-center text-[12px] text-faint">
              No logins found for {host}.
            </p>
          ) : (
            filtered.map((item, i) => (
              <button
                key={item.id}
                type="button"
                onMouseMove={() => setSelected(i)}
                onClick={() => void pick(item)}
                className={cn(
                  "flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-left",
                  i === selected && "bg-accent/15",
                )}
              >
                <span className="grid size-4 shrink-0 place-items-center rounded-[4px] bg-ink/8 text-[9px] font-semibold text-muted">
                  {(item.title.charAt(0) || "•").toUpperCase()}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] text-text">{item.title}</span>
                  <span className="block truncate text-[10.5px] text-faint">{item.username}</span>
                </span>
                {filling && i === selected ? (
                  <span className="shrink-0 text-[10px] text-faint">Filling…</span>
                ) : null}
              </button>
            ))
          )}
        </div>
      </ModalContent>
    </Modal>
  );
}
