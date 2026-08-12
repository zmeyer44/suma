import { useState } from "react";
import { Check } from "lucide-react";
import { useSumaStore } from "../store";
import { Input } from "./ui/input";

/**
 * "Recover on a new device" (§8.2): the offline recovery code unwraps the
 * space keys on a fresh Mac. Lives in the settings overlay.
 */
export function RecoveryPanel() {
  const recoverKeys = useSumaStore((s) => s.recoverKeys);

  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [recovered, setRecovered] = useState<number | null>(null);

  const submit = async () => {
    const trimmed = code.trim();
    if (trimmed.length === 0 || busy) return;
    setBusy(true);
    const result = await recoverKeys(trimmed);
    setBusy(false);
    if (result !== undefined) {
      setRecovered(result.spacesRecovered);
      setCode("");
    }
  };

  return (
    <div>
      <p className="mb-2 text-[11px] leading-snug text-faint">
        New Mac, or lost your other devices? Enter your recovery code to unlock your encrypted
        spaces here.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="flex items-center gap-2"
      >
        {/* The focus glow rides on the shared field's ring-accent, not a
            hardcoded rgb(): it used to be frozen at the old default accent and
            stayed blue through every themed palette. */}
        <Input
          size="lg"
          type="text"
          value={code}
          spellCheck={false}
          autoComplete="off"
          placeholder="Recovery code"
          aria-label="Recovery code"
          onChange={(e) => {
            setCode(e.target.value);
            setRecovered(null);
          }}
          className="flex-1 font-mono placeholder:font-sans"
        />
        <button
          type="submit"
          disabled={code.trim().length === 0 || busy}
          className="shrink-0 cursor-pointer rounded-lg bg-accent/15 px-3 py-1.5 text-[12px] font-medium text-accent hover:bg-accent/25 disabled:cursor-default disabled:opacity-40"
        >
          {busy ? "Recovering…" : "Recover keys"}
        </button>
      </form>
      {recovered !== null ? (
        <p className="mt-2 flex items-center gap-1.5 text-[12px] font-medium text-ok">
          <Check className="size-3" aria-hidden="true" />
          {recovered} space{recovered === 1 ? "" : "s"} recovered on this Mac.
        </p>
      ) : null}
    </div>
  );
}
