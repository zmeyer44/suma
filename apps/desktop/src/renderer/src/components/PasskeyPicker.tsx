import { useEffect, useRef, useState } from "react";
import { KeyRound } from "lucide-react";
import { cn } from "../lib/cn";
import { useSumaStore } from "../store";

/**
 * Passkey account picker (PRD §4 Assisted continuity).
 *
 * Electron ships no UI for `select-webauthn-account`, and the WebAuthn
 * ceremony stays pending until something answers it — so this overlay is
 * load-bearing, not decoration: dismissing it cancels the sign-in, and
 * failing to render it would hang the page. Escape and the backdrop both
 * cancel explicitly rather than leaving the request in limbo.
 */
export function PasskeyPicker() {
  const request = useSumaStore((s) => s.passkeyRequest);
  const choose = useSumaStore((s) => s.choosePasskeyAccount);
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => setIndex(0), [request?.requestId]);

  useEffect(() => {
    if (request === null) return;
    listRef.current?.focus();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        void choose(null);
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setIndex((i) => Math.min(i + 1, request.accounts.length - 1));
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        const account = request.accounts[index];
        if (account !== undefined) void choose(account.credentialId);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [request, index, choose]);

  if (request === null) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="veil absolute inset-0"
        onClick={() => void choose(null)}
        aria-hidden="true"
      />
      <div
        ref={listRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={`Choose a passkey for ${request.relyingPartyId}`}
        className="animate-overlay-in relative w-[380px] rounded-2xl border border-hairline bg-raised p-4 shadow-pop outline-none"
      >
        <div className="flex items-center gap-2">
          <KeyGlyph />
          <div className="min-w-0">
            <p className="text-[13px] font-semibold">Choose a passkey</p>
            <p className="truncate font-mono text-[10px] text-faint">{request.relyingPartyId}</p>
          </div>
        </div>

        <div className="mt-3 flex flex-col gap-1">
          {request.accounts.map((account, i) => (
            <button
              key={account.credentialId}
              type="button"
              onMouseEnter={() => setIndex(i)}
              onClick={() => void choose(account.credentialId)}
              className={cn(
                "flex items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors",
                i === index ? "bg-accent/15 ring-1 ring-accent/40" : "hover:bg-ink/5",
              )}
            >
              <span className="grid size-7 shrink-0 place-items-center rounded-full bg-ink/8 text-[11px] font-semibold uppercase">
                {account.name.slice(0, 1)}
              </span>
              <span className="min-w-0">
                <span className="block truncate text-[12px] font-medium">{account.name}</span>
                <span className="block truncate text-[10px] text-faint">{account.detail}</span>
              </span>
            </button>
          ))}
        </div>

        <div className="mt-3 flex items-center justify-between">
          <p className="text-[10px] text-faint">Touch ID confirms your choice</p>
          <button
            type="button"
            onClick={() => void choose(null)}
            className="rounded-md px-2 py-1 text-[11px] text-muted transition-colors hover:bg-ink/6 hover:text-text"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function KeyGlyph() {
  return (
    <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-accent/15 text-accent">
      <KeyRound className="size-4" aria-hidden="true" />
    </span>
  );
}
