"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { Shell } from "@/components/section";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { WaitlistStatus } from "@/lib/waitlist-store";

const FALLBACK_ADDRESS = "invites@sumabrowser.com";

/** Mirrors REFERRAL_BOOST server-side; the copy below promises this number. */
const PLACES_PER_FRIEND = 5;

/** Your spot, remembered locally so a return visit reopens the ticket. */
const STORAGE_KEY = "suma.waitlist";
/** A referral code seen on arrival, held for the length of the visit. */
const REF_KEY = "suma.waitlist.ref";

/** Cells in the queue strip — two rows of the site's pixel motif. */
const STRIP_CELLS = 28;

const INCLUDED = [
  ["Browser", "Suma on every device you own"],
  ["Workspace", "Spaces, tabs, sign-ins and settings, everywhere"],
  ["Library", "Saves, offline videos and read-aloud, synced"],
  ["Machine", "An always-on computer with a built-in terminal and IDE"],
  ["Price", "Free through the beta; founding terms after"],
];

type Spot = WaitlistStatus & { email: string; inviteCode: string | null };

function readStoredSpot(): { email: string; code: string } | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { email?: unknown; code?: unknown };
    if (typeof parsed.email !== "string" || typeof parsed.code !== "string") {
      return null;
    }
    return { email: parsed.email, code: parsed.code };
  } catch {
    return null;
  }
}

export function Waitlist() {
  const [email, setEmail] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [spot, setSpot] = useState<Spot | null>(null);
  const [returning, setReturning] = useState(false);
  const [refCode, setRefCode] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const linkRef = useRef<HTMLInputElement | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // On arrival: capture ?ref= from an invite link, then reopen a stored spot.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const ref = params.get("ref");
    if (ref && /^[a-z0-9]{1,32}$/i.test(ref)) {
      window.sessionStorage.setItem(REF_KEY, ref.toLowerCase());
    }
    setRefCode(window.sessionStorage.getItem(REF_KEY));

    const stored = readStoredSpot();
    if (!stored) return;

    // Re-joining with the stored email is the refresh: idempotent on the
    // server, returns the invite code once promoted, and quietly re-enters
    // the line if the record vanished server-side.
    let cancelled = false;
    fetch("/api/waitlist", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: stored.email }),
    })
      .then(async (response) => {
        if (cancelled || !response.ok) return;
        const data = (await response.json()) as WaitlistStatus & {
          inviteCode: string | null;
        };
        if (cancelled) return;
        setSpot({ ...data, email: stored.email, inviteCode: data.inviteCode });
        setReturning(true);
        window.localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({ email: stored.email, code: data.code }),
        );
      })
      .catch(() => {
        // Offline or flaky — the form still works, so say nothing.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    };
  }, []);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!email || sending) return;

    setSending(true);
    setError(null);
    try {
      const response = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, ref: refCode }),
      });
      const data = (await response.json()) as
        | (WaitlistStatus & { alreadyJoined: boolean; inviteCode: string | null })
        | { error: string };
      if (!response.ok || "error" in data) {
        setError("error" in data ? data.error : "Something went wrong.");
        return;
      }
      const joined: Spot = { ...data, email: email.trim().toLowerCase() };
      setSpot(joined);
      setReturning(data.alreadyJoined);
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ email: joined.email, code: joined.code }),
      );
    } catch {
      setError("That didn’t go through — check your connection and try again.");
    } finally {
      setSending(false);
    }
  }

  function resetSpot() {
    window.localStorage.removeItem(STORAGE_KEY);
    setSpot(null);
    setReturning(false);
    setEmail("");
    setCopied(false);
  }

  const referralUrl = useMemo(
    () => (spot ? `${window.location.origin}/r/${spot.code}` : ""),
    [spot],
  );

  async function copyText(text: string) {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard blocked — select the text so a manual ⌘C still lands.
      linkRef.current?.focus();
      linkRef.current?.select();
      return;
    }
    setCopied(true);
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(false), 2000);
  }

  return (
    <section id="access" className="relative z-10 scroll-mt-24 pb-6">
      <Shell>
        {/* The closing panel, inset and rounded rather than a full-bleed band —
            the page ends on a surface, not on an edge. */}
        <div
          data-pixel="card"
          className="grid gap-x-16 gap-y-14 rounded-2xl bg-ink px-5 py-16 text-paper sm:rounded-3xl sm:px-12 sm:py-20 lg:grid-cols-12 lg:px-16"
        >
          <div aria-live="polite" className="min-w-0 lg:col-span-6">
            {spot?.invited ? (
              <InvitedTicket
                spot={spot}
                copied={copied}
                onCopy={copyText}
                onReset={resetSpot}
              />
            ) : spot ? (
              <SpotTicket
                spot={spot}
                returning={returning}
                referralUrl={referralUrl}
                copied={copied}
                onCopy={() => void copyText(referralUrl)}
                onReset={resetSpot}
                linkRef={linkRef}
              />
            ) : (
              <>
                <p className="font-mono text-[0.6875rem] uppercase tracking-[0.16em] text-paper/45">
                  Early access · invite only
                </p>
                <h2 className="display mt-7 text-[clamp(2.1rem,4.6vw,3.75rem)] uppercase">
                  Stop rebuilding
                  <br />
                  your desk.
                </h2>
                <p className="mt-8 max-w-[42ch] text-[1.0625rem] leading-[1.6] text-paper/60">
                  Suma is in private beta with people who work from more than
                  one place, on more than one device. Join the line and
                  we&rsquo;ll show you your spot — every friend you bring in
                  moves you up. Already in line? Enter the same email to see
                  where you stand.
                </p>

                {refCode ? (
                  <p className="mt-6 inline-flex items-center gap-3 rounded-full bg-white/[0.07] px-5 py-2.5 font-mono text-[0.6875rem] uppercase tracking-[0.14em] text-paper/70">
                    <span aria-hidden className="size-2 shrink-0 bg-royal" />
                    Invite link detected — joining moves your friend up
                  </p>
                ) : null}

                <form onSubmit={onSubmit} className="mt-10 max-w-[34rem]">
                  <label className="sr-only" htmlFor="waitlist-email">
                    Email address
                  </label>
                  <div className="flex flex-col gap-2 rounded-full bg-white/[0.07] p-2 sm:flex-row sm:items-center">
                    <input
                      id="waitlist-email"
                      type="email"
                      required
                      autoComplete="email"
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                      placeholder="you@company.com"
                      className="min-w-0 flex-1 rounded-full bg-transparent px-5 py-3 text-[1.0625rem] text-paper placeholder:text-paper/30 focus:outline-none"
                    />
                    <Button
                      type="submit"
                      disabled={sending}
                      className="h-auto shrink-0 rounded-full bg-paper px-6 py-3.5 text-[0.9375rem] text-ink hover:bg-royal hover:text-paper"
                    >
                      {sending ? "Joining…" : "Join the waitlist"}
                    </Button>
                  </div>
                </form>

                {error ? (
                  <p className="mt-4 font-mono text-[0.75rem] text-paper/60">
                    {error} Or email{" "}
                    <a className="underline" href={`mailto:${FALLBACK_ADDRESS}`}>
                      {FALLBACK_ADDRESS}
                    </a>
                    .
                  </p>
                ) : (
                  <p className="mt-4 font-mono text-[0.6875rem] uppercase tracking-[0.14em] text-paper/35">
                    No newsletter · one message when there&rsquo;s a seat
                  </p>
                )}
              </>
            )}
          </div>

          <dl className="min-w-0 lg:col-span-5 lg:col-start-8">
            <p className="pb-4 font-mono text-[0.6875rem] uppercase tracking-[0.16em] text-paper/45">
              What a seat includes
            </p>
            <div className="flex flex-col gap-2">
              {INCLUDED.map(([label, value]) => (
                <div
                  key={label}
                  className="flex flex-col gap-1.5 rounded-lg bg-white/[0.06] px-5 py-4 sm:flex-row sm:gap-6"
                >
                  <dt className="shrink-0 font-mono text-[0.6875rem] uppercase leading-[1.9] tracking-[0.16em] text-paper/45 sm:w-[6.5rem]">
                    {label}
                  </dt>
                  <dd className="min-w-0 text-[0.9375rem] leading-[1.5] text-paper/85">
                    {value}
                  </dd>
                </div>
              ))}
            </div>
            <p className="mt-6 font-mono text-[0.6875rem] uppercase tracking-[0.14em] text-paper/35">
              Desktop app · macOS 14+ · Apple Silicon
            </p>
          </dl>
        </div>
      </Shell>
    </section>
  );
}

/**
 * The line is behind them: the invite code, the download, and how to redeem
 * it. Replaces the queue ticket entirely — position is no longer the story.
 */
function InvitedTicket({
  spot,
  copied,
  onCopy,
  onReset,
}: {
  spot: Spot;
  copied: boolean;
  onCopy: (text: string) => Promise<void>;
  onReset: () => void;
}) {
  return (
    <div>
      <p className="font-mono text-[0.6875rem] uppercase tracking-[0.16em] text-paper/45">
        Early access · your seat is ready
      </p>
      <h2 className="display mt-7 text-[clamp(2.5rem,5.5vw,4.5rem)] uppercase">
        You&rsquo;re in.
      </h2>
      <p className="mt-8 max-w-[42ch] text-[1.0625rem] leading-[1.6] text-paper/60">
        Download Suma and create your account with{" "}
        <span className="text-paper/90">{spot.email}</span> — the app will ask
        for this invite code. It only works with your email.
      </p>

      {spot.inviteCode ? (
        <div className="mt-8 flex max-w-[34rem] flex-col gap-2 rounded-full bg-white/[0.07] p-2 sm:flex-row sm:items-center">
          <span className="min-w-0 flex-1 truncate px-5 py-3 font-mono text-[1.0625rem] tracking-[0.08em] text-paper">
            {spot.inviteCode}
          </span>
          <Button
            type="button"
            onClick={() => void onCopy(spot.inviteCode ?? "")}
            className="h-auto shrink-0 rounded-full bg-paper px-6 py-3.5 text-[0.9375rem] text-ink hover:bg-royal hover:text-paper"
          >
            {copied ? "Copied" : "Copy code"}
          </Button>
        </div>
      ) : null}

      <div className="mt-8 flex flex-wrap items-center gap-x-7 gap-y-4">
        <a
          href="/download"
          data-pixel="control"
          className="group inline-flex items-center gap-2.5 rounded-full bg-royal px-7 py-3.5 text-[0.9375rem] font-medium text-paper transition-colors hover:bg-paper hover:text-ink"
        >
          Download for macOS
          <span
            aria-hidden
            className="transition-transform duration-300 group-hover:translate-x-1"
          >
            →
          </span>
        </a>
        <button
          type="button"
          onClick={onReset}
          className="font-mono text-[0.6875rem] uppercase tracking-[0.14em] text-paper/35 underline-offset-4 transition-colors hover:text-paper hover:underline"
        >
          Not you? Use another email
        </button>
      </div>
    </div>
  );
}

/**
 * The ticket: your place set as large as the headline it replaces, the queue
 * drawn in the site's pixel idiom, and the link that moves you up it.
 */
function SpotTicket({
  spot,
  returning,
  referralUrl,
  copied,
  onCopy,
  onReset,
  linkRef,
}: {
  spot: Spot;
  returning: boolean;
  referralUrl: string;
  copied: boolean;
  onCopy: () => void;
  onReset: () => void;
  linkRef: React.RefObject<HTMLInputElement | null>;
}) {
  const ahead = spot.position - 1;
  const behind = Math.max(0, spot.total - spot.position);
  const yourCell =
    spot.total <= 1
      ? 0
      : Math.min(
          STRIP_CELLS - 1,
          Math.round((ahead / (spot.total - 1)) * (STRIP_CELLS - 1)),
        );

  const shareText = `I'm #${spot.position.toLocaleString("en-US")} in line for Suma — the browser whose workspace follows you across devices. Join through my link and move me up:`;

  return (
    <div>
      <p className="font-mono text-[0.6875rem] uppercase tracking-[0.16em] text-paper/45">
        {returning
          ? "Early access · welcome back"
          : "Early access · you’re in line"}
      </p>

      <p className="display mt-6 text-[clamp(4rem,10vw,7.5rem)] uppercase leading-none">
        <span aria-hidden className="text-royal">
          #
        </span>
        <span className="sr-only">Number </span>
        {spot.position.toLocaleString("en-US")}
      </p>
      <p className="mt-4 font-mono text-[0.75rem] text-paper/60">
        of {spot.total.toLocaleString("en-US")} in line · joined as {spot.email}
      </p>

      {/* The queue, drawn on the site's grid: everyone ahead of you, you in
          royal, everyone behind. */}
      <div className="mt-8 max-w-[34rem]">
        <div className="flex gap-[3px]">
          {Array.from({ length: STRIP_CELLS }, (_, i) => (
            <span
              key={i}
              className={cn(
                "h-2 flex-1",
                i < yourCell && "bg-paper/25",
                i === yourCell && "bg-royal",
                i > yourCell && "bg-white/[0.08]",
              )}
            />
          ))}
        </div>
        <div className="mt-2.5 flex justify-between font-mono text-[0.625rem] uppercase tracking-[0.14em] text-paper/40">
          <span>Front of the line</span>
          <span>
            {ahead.toLocaleString("en-US")} ahead ·{" "}
            {behind.toLocaleString("en-US")} behind
          </span>
        </div>
      </div>

      <div className="mt-10 max-w-[34rem] border-t border-white/15 pt-7">
        <p className="font-mono text-[0.6875rem] uppercase tracking-[0.16em] text-paper/45">
          Move up the line
        </p>
        <p className="mt-3 text-[0.9375rem] leading-[1.6] text-paper/60">
          Each friend who joins through your link moves you up{" "}
          <span className="text-paper/90">
            {PLACES_PER_FRIEND} places
          </span>
          .{" "}
          {spot.referrals > 0 ? (
            <span className="text-paper/90">
              {spot.referrals.toLocaleString("en-US")}{" "}
              {spot.referrals === 1 ? "friend has" : "friends have"} joined
              through yours.
            </span>
          ) : null}
        </p>

        <div className="mt-5 flex flex-col gap-2 rounded-full bg-white/[0.07] p-2 sm:flex-row sm:items-center">
          <label className="sr-only" htmlFor="waitlist-referral-link">
            Your referral link
          </label>
          <input
            id="waitlist-referral-link"
            ref={linkRef}
            readOnly
            value={referralUrl}
            onFocus={(event) => event.currentTarget.select()}
            className="min-w-0 flex-1 truncate rounded-full bg-transparent px-5 py-3 font-mono text-[0.8125rem] text-paper/85 focus:outline-none"
          />
          <Button
            type="button"
            onClick={onCopy}
            className="h-auto shrink-0 rounded-full bg-paper px-6 py-3.5 text-[0.9375rem] text-ink hover:bg-royal hover:text-paper"
          >
            {copied ? "Copied" : "Copy link"}
          </Button>
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-x-7 gap-y-2 font-mono text-[0.6875rem] uppercase tracking-[0.14em]">
          <a
            className="text-paper/55 underline-offset-4 transition-colors hover:text-paper hover:underline"
            href={`https://x.com/intent/post?text=${encodeURIComponent(shareText)}&url=${encodeURIComponent(referralUrl)}`}
            target="_blank"
            rel="noreferrer"
          >
            Share on X
          </a>
          <a
            className="text-paper/55 underline-offset-4 transition-colors hover:text-paper hover:underline"
            href={`mailto:?subject=${encodeURIComponent("A browser worth a spot in line")}&body=${encodeURIComponent(`${shareText}\n\n${referralUrl}`)}`}
          >
            Email a friend
          </a>
          <button
            type="button"
            onClick={onReset}
            className="text-paper/35 underline-offset-4 transition-colors hover:text-paper hover:underline"
          >
            Not you? Use another email
          </button>
        </div>
      </div>
    </div>
  );
}
