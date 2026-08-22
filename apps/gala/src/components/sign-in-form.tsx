"use client";

import { ArrowRight, LoaderCircle, LockKeyhole } from "lucide-react";
import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { signInAction, type SignInState } from "@/app/sign-in/actions";
import { Button } from "@/components/ui/button";

const initialState: SignInState = { error: null };

function SubmitButton({ configured }: { configured: boolean }) {
  const { pending } = useFormStatus();
  return (
    <Button
      type="submit"
      variant="bare"
      size="none"
      disabled={!configured || pending}
      className="group mt-2 flex w-full items-center justify-between bg-ink px-5 py-3.5 text-sm text-white transition-colors enabled:hover:bg-coral disabled:cursor-not-allowed disabled:opacity-45"
    >
      <span>{pending ? "Opening Gala…" : "Sign in"}</span>
      <span className="grid size-7 place-items-center bg-white text-ink">
        {pending ? (
          <LoaderCircle className="size-3.5 animate-spin" />
        ) : (
          <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
        )}
      </span>
    </Button>
  );
}

export function SignInForm({
  configured,
  returnTo,
}: {
  configured: boolean;
  returnTo: string;
}) {
  const [state, action] = useActionState(signInAction, initialState);

  return (
    <form action={action} className="mt-9 space-y-5">
      <input type="hidden" name="returnTo" value={returnTo} />
      <label className="block">
        <span className="mb-2 block text-xs text-muted">Email</span>
        <input
          required
          autoComplete="email"
          inputMode="email"
          name="email"
          type="email"
          placeholder="you@example.com"
          className="w-full border border-line bg-white px-4 py-3.5 text-sm outline-none transition-colors placeholder:text-muted/45 focus:border-violet"
        />
      </label>
      <label className="block">
        <span className="mb-2 block text-xs text-muted">Password</span>
        <input
          required
          autoComplete="current-password"
          name="password"
          type="password"
          placeholder="Your password"
          className="w-full border border-line bg-white px-4 py-3.5 text-sm outline-none transition-colors placeholder:text-muted/45 focus:border-violet"
        />
      </label>
      {state.error && (
        <p
          role="alert"
          className="border-l-4 border-coral bg-coral/10 px-3 py-2.5 text-xs leading-5 text-[#b52e14]"
        >
          {state.error}
        </p>
      )}
      {!configured && !state.error && (
        <p className="border border-line bg-white px-3 py-2.5 text-xs leading-5 text-muted">
          This deployment needs its operator credentials before sign-in can be
          used.
        </p>
      )}
      <SubmitButton configured={configured} />
      <p className="flex items-center justify-center gap-2 text-[0.66rem] text-muted">
        <LockKeyhole className="size-3" />
        Seven-day encrypted session · sign out anytime
      </p>
    </form>
  );
}
