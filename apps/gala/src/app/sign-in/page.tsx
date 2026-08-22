import type { Metadata } from "next";
import { ArrowLeft, Check, Sparkles } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";

import { GalaMark } from "@/components/gala-mark";
import { SignInForm } from "@/components/sign-in-form";
import { Button } from "@/components/ui/button";
import { authIsConfigured, canonicalReturnTo, getSession } from "@/lib/auth";

export const metadata: Metadata = {
  title: "Sign in",
  robots: { index: false, follow: false },
};

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ returnTo?: string }>;
}) {
  if (await getSession()) redirect("/home");
  const { returnTo: rawReturnTo } = await searchParams;
  const returnTo = canonicalReturnTo(rawReturnTo ?? null);

  return (
    <main className="grid min-h-dvh lg:grid-cols-[0.92fr_1.08fr]">
      <section className="paper-noise flex min-h-dvh flex-col bg-cream px-5 py-5 sm:px-10 sm:py-8 lg:px-14">
        <div className="flex items-center justify-between">
          <GalaMark />
          <Button
            asChild
            variant="bare"
            size="none"
            className="inline-flex items-center gap-2 text-xs text-muted transition-colors hover:text-ink"
          >
            <Link href="/">
              <ArrowLeft className="size-3.5" />
              Back to the site
            </Link>
          </Button>
        </div>
        <div className="my-auto mx-auto w-full max-w-md py-16">
          <p className="eyebrow text-violet">Welcome back</p>
          <h1 className="font-display mt-4 text-6xl font-semibold leading-[1] tracking-[-0.04em] sm:text-7xl">
            Gala is
            <span className="block text-electric">expecting you.</span>
          </h1>
          <p className="mt-5 max-w-sm text-sm leading-6 text-muted">
            Sign in to connect your channels, choose what Gala can do, and see
            what she’s been working on.
          </p>
          <SignInForm configured={authIsConfigured()} returnTo={returnTo} />
        </div>
        <p className="text-[0.66rem] text-muted">Gala · a Suma agent</p>
      </section>

      <aside className="dashboard-grid relative hidden min-h-dvh overflow-hidden bg-plum p-12 text-white lg:flex lg:flex-col lg:justify-between">
        <div className="hero-grid-fade absolute right-8 top-8 h-48 w-72 opacity-35" />
        <div className="absolute -right-20 top-1/2 font-display text-[25rem] font-black leading-none text-white/5">
          G
        </div>
        <div className="relative flex items-center gap-2 text-[0.65rem] uppercase tracking-[0.18em] text-white/55">
          <span className="size-2 rounded-full bg-coral shadow-[0_0_14px_#f35d3d]" />
          Private operator console
        </div>
        <div className="relative max-w-xl">
          <div className="mb-9 grid size-16 place-items-center bg-coral text-white">
            <Sparkles className="size-6" />
          </div>
          <blockquote className="font-display text-5xl font-semibold leading-[1] tracking-[-0.04em] xl:text-6xl">
            “One place to decide how Gala shows up everywhere else.”
          </blockquote>
          <ul className="mt-10 grid gap-3 text-sm text-white/60 sm:grid-cols-2">
            {[
              "Link channels",
              "Share browser sessions",
              "Set tool permissions",
              "Review activity",
            ].map((item) => (
              <li key={item} className="flex items-center gap-2">
                <span className="grid size-4 place-items-center border border-white/45 text-coral">
                  <Check className="size-2.5" />
                </span>
                {item}
              </li>
            ))}
          </ul>
        </div>
        <p className="relative max-w-sm text-[0.66rem] leading-5 text-white/40">
          Authentication stays server-side. Credentials are never exposed to the
          browser bundle.
        </p>
      </aside>
    </main>
  );
}
