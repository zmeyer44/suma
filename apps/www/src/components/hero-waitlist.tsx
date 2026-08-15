"use client";

import { useState } from "react";

import {
  WAITLIST_JOINED_EVENT,
  WAITLIST_REF_KEY,
  WAITLIST_STORAGE_KEY,
  type WaitlistJoined,
} from "@/lib/waitlist-client";
import type { WaitlistStatus } from "@/lib/waitlist-store";

/**
 * The hero's email capture, wired to the real waitlist. A join here lands the
 * same spot the closing section shows: the result is stored under the shared
 * key and announced on the shared event, so the ticket at `#access` is
 * already open by the time the reader scrolls to it.
 */
export function HeroWaitlist() {
  const [email, setEmail] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [joined, setJoined] = useState<WaitlistJoined | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!email || sending) return;

    setSending(true);
    setError(null);
    try {
      const response = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email,
          ref: window.sessionStorage.getItem(WAITLIST_REF_KEY),
        }),
      });
      const data = (await response.json()) as
        | (WaitlistStatus & {
            alreadyJoined: boolean;
            inviteCode: string | null;
          })
        | { error: string };
      if (!response.ok || "error" in data) {
        setError("error" in data ? data.error : "Something went wrong.");
        return;
      }
      const spot: WaitlistJoined = {
        ...data,
        email: email.trim().toLowerCase(),
      };
      window.localStorage.setItem(
        WAITLIST_STORAGE_KEY,
        JSON.stringify({ email: spot.email, code: spot.code }),
      );
      window.dispatchEvent(
        new CustomEvent<WaitlistJoined>(WAITLIST_JOINED_EVENT, {
          detail: spot,
        }),
      );
      setJoined(spot);
    } catch {
      setError("That didn’t go through — check your connection and try again.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div aria-live="polite">
      {joined ? (
        <p className="max-w-[34rem] text-[1.0625rem] leading-[1.6]">
          {joined.invited ? (
            "Your seat is ready."
          ) : (
            <>
              You&rsquo;re{" "}
              <span className="font-medium">
                #{joined.position.toLocaleString("en-US")}
              </span>{" "}
              of {joined.total.toLocaleString("en-US")} in line.
            </>
          )}{" "}
          <a
            href="#access"
            className="font-medium underline underline-offset-4"
          >
            See your spot
            <span aria-hidden className="ml-1.5">
              ↓
            </span>
          </a>
        </p>
      ) : (
        <form onSubmit={onSubmit} className="max-w-[30rem]">
          <label className="sr-only" htmlFor="hero-email">
            Email address
          </label>
          {/* Two pills on mobile, one shared pill from `sm` up — a single
              tall capsule around a stacked input and button reads as a blob. */}
          <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:gap-2 sm:rounded-full sm:border sm:bg-paper-raised sm:p-2 sm:shadow-[0_16px_40px_-24px_rgba(10,14,24,0.35)]">
            <input
              id="hero-email"
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@company.com"
              className="min-w-0 flex-1 rounded-full border bg-paper-raised px-5 py-3.5 text-[1rem] placeholder:text-muted-foreground/60 focus:outline-none sm:border-0 sm:bg-transparent sm:py-3"
            />
            <button
              type="submit"
              disabled={sending}
              className="shrink-0 rounded-full bg-ink px-6 py-3.5 text-[0.9375rem] font-medium text-paper transition-colors hover:bg-ink/85 sm:py-3"
            >
              {sending ? "Joining…" : "Get early access"}
            </button>
          </div>
          {error ? (
            <p className="mt-3 font-mono text-[0.75rem] text-destructive">
              {error}
            </p>
          ) : null}
        </form>
      )}
    </div>
  );
}
