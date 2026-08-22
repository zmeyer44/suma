import {
  ArrowRight,
  ArrowUpRight,
  Bot,
  Check,
  Globe2,
  Grid3X3,
  Hash,
  LockKeyhole,
  MessageCircleMore,
  MousePointer2,
  ShieldCheck,
  SquareTerminal,
  Waypoints,
} from "lucide-react";
import Link from "next/link";

import { GalaMark } from "@/components/gala-mark";
import { HeroCardStack } from "@/components/hero-card-stack";
import { Button } from "@/components/ui/button";

const capabilities = [
  {
    icon: Globe2,
    title: "Use your browser",
    copy: "Signed-in sessions, full navigation, and page control.",
  },
  {
    icon: SquareTerminal,
    title: "Run the machine",
    copy: "Terminals, long jobs, files, and coding agents.",
  },
  {
    icon: Waypoints,
    title: "Keep the thread",
    copy: "One working memory across every conversation surface.",
  },
  {
    icon: ShieldCheck,
    title: "Stay in control",
    copy: "Scoped permissions, visible activity, instant revocation.",
  },
];

const channels = [
  {
    name: "iMessage",
    note: "BlueBubbles bridge",
    icon: MessageCircleMore,
    style: "bg-white text-ink",
    indexStyle: "text-violet",
  },
  {
    name: "Slack",
    note: "Your workspace bot",
    icon: Hash,
    style: "bg-electric text-white",
    indexStyle: "text-white/60",
  },
  {
    name: "Telegram",
    note: "Your private bot",
    icon: MessageCircleMore,
    style: "bg-coral text-white",
    indexStyle: "text-white/60",
  },
];

export default function LandingPage() {
  return (
    <main className="paper-noise overflow-hidden">
      <div className="hero-blueprint relative overflow-hidden text-white">
        <header className="relative z-20 mx-auto flex max-w-[1490px] items-center justify-between px-5 pb-5 pt-6 sm:px-8 lg:px-14">
          <GalaMark inverted showGlyph={false} suffix="sh" />
          <nav
            className="hidden items-center gap-9 text-sm text-white/85 lg:flex"
            aria-label="Main navigation"
          >
            <a
              className="transition-opacity hover:opacity-60"
              href="#what-gala-does"
            >
              What Gala does
            </a>
            <a className="transition-opacity hover:opacity-60" href="#channels">
              Channels
            </a>
            <a className="transition-opacity hover:opacity-60" href="#trust">
              Trust & control
            </a>
          </nav>
          <Button
            asChild
            variant="coral"
            size="default"
            className="group h-auto gap-3 px-5 py-3"
          >
            <Link href="/sign-in">
              Sign in
              <ArrowUpRight className="size-3.5 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
            </Link>
          </Button>
        </header>

        <section className="hero-main-grid relative z-10 mx-auto grid max-w-[1490px] items-center gap-12 px-5 pb-12 pt-8 sm:px-8 lg:grid-cols-[minmax(430px,520px)_minmax(0,1fr)] lg:gap-7 lg:px-14 lg:pb-10 lg:pt-7 xl:min-h-[655px]">
          <div className="w-full max-w-[520px] py-4 lg:py-8">
            <div className="mb-9 max-w-[410px]">
              <div
                className="mb-5 grid w-fit grid-cols-2 gap-1.5"
                aria-hidden="true"
              >
                {[0, 1, 2, 3].map((index) => (
                  <span key={index} className="size-3 rounded-full bg-white" />
                ))}
              </div>
              <div className="relative h-px bg-white/65">
                <span className="absolute -left-0.5 top-1/2 size-3 -translate-y-1/2 rounded-full bg-coral" />
                <span className="absolute -right-0.5 top-1/2 size-3 -translate-y-1/2 rounded-full bg-white" />
              </div>
              <div className="mt-3 flex justify-between text-[0.62rem] uppercase tracking-[0.15em] text-white/70">
                <span>You</span>
                <span>Gala</span>
              </div>
            </div>

            <h1 className="font-display max-w-xl text-[clamp(3.15rem,5vw,4.875rem)] font-semibold leading-[1.04] tracking-[-0.025em]">
              Your agent.
              <span className="block">Your accounts.</span>
              <span className="block text-[#8ba3ff]">In motion.</span>
            </h1>
            <p className="mt-6 max-w-[470px] text-[1.05rem] leading-[1.55] text-white/82">
              Message Gala from the places you already talk. She can use your
              signed-in browser, run terminals, and steer the same tools you use
              on desktop—even when the app is closed.
            </p>
            <div className="mt-7 flex flex-wrap items-center gap-x-11 gap-y-4">
              <Button
                asChild
                variant="bare"
                size="none"
                className="group inline-flex items-center gap-9 rounded-[4px] bg-white px-8 py-4 text-base font-semibold text-ink shadow-[0_10px_25px_rgba(0,0,20,0.2)] transition-colors hover:bg-coral hover:text-white"
              >
                <Link href="/sign-in">
                  Open your Gala
                  <ArrowUpRight className="size-4 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
                </Link>
              </Button>
              <Button
                asChild
                variant="bare"
                size="none"
                className="group inline-flex items-center gap-3 py-3 text-base font-medium text-white/85"
              >
                <a href="#what-gala-does">
                  See how it works
                  <ArrowRight className="size-4 transition-transform group-hover:translate-x-1" />
                </a>
              </Button>
            </div>
            <div className="mt-7 flex flex-wrap gap-x-7 gap-y-3 text-sm font-medium text-white/75">
              {["Identity-linked", "Policy-bound", "Revocable anytime"].map(
                (item) => (
                  <span key={item} className="flex items-center gap-2">
                    <span className="grid size-4 place-items-center border border-white/55">
                      <Check className="size-2.5" />
                    </span>
                    {item}
                  </span>
                ),
              )}
            </div>
          </div>

          <HeroCardStack />

          <div
            className="hero-side-motif self-stretch flex-col items-center justify-center"
            aria-hidden="true"
            data-testid="hero-side-motif"
          >
            <div className="hero-side-dots h-[355px] w-full" />
            <ArrowUpRight
              className="-ml-4 mt-4 size-[92px] self-start text-coral"
              strokeWidth={2.5}
            />
          </div>
        </section>
      </div>

      <section className="border-b border-line bg-cream px-5 py-14 sm:px-8 lg:px-12">
        <div className="mx-auto grid max-w-[1344px] lg:grid-cols-[1.1fr_repeat(4,1fr)]">
          <div className="border-b border-line pb-8 pr-8 lg:border-b-0 lg:border-r lg:pb-0">
            <p className="eyebrow text-violet">Full desktop reach</p>
            <h2 className="font-display mt-5 max-w-sm text-4xl font-semibold leading-[1.08] tracking-[-0.025em]">
              One agent. Every surface.
            </h2>
          </div>
          {capabilities.map(({ icon: Icon, title, copy }) => (
            <article
              key={title}
              className="border-b border-line py-7 lg:border-b-0 lg:border-r lg:px-7 lg:py-0 last:lg:border-r-0"
            >
              <Icon className="size-7 text-violet" strokeWidth={1.5} />
              <h3 className="mt-8 text-base text-ink">{title}</h3>
              <p className="mt-2 text-xs leading-5 text-muted">{copy}</p>
            </article>
          ))}
        </div>
      </section>

      <section
        id="what-gala-does"
        className="bg-white px-5 py-24 sm:px-8 lg:px-12 lg:py-32"
      >
        <div className="mx-auto max-w-[1344px]">
          <div className="grid gap-10 lg:grid-cols-[0.7fr_1.3fr]">
            <div>
              <p className="eyebrow text-coral">A longer reach</p>
              <p className="mt-4 max-w-xs text-sm leading-6 text-muted">
                Not a second assistant. Gala is another door into the same one.
              </p>
            </div>
            <h2 className="font-display text-balance text-[clamp(3.2rem,5.4vw,5.75rem)] font-semibold leading-[1.01] tracking-[-0.04em] text-ink">
              The full desktop agent,
              <span className="block text-electric">without the desktop.</span>
            </h2>
          </div>
          <div className="mt-20 grid border-t border-line md:grid-cols-3">
            {[
              {
                icon: MousePointer2,
                number: "01",
                title: "Works where you’re signed in",
                copy: "Gala can use a shared Suma browser session, then navigate, click, type, upload, and finish the job.",
              },
              {
                icon: SquareTerminal,
                number: "02",
                title: "Reaches the whole machine",
                copy: "Launch terminals, work with files, and hand coding tasks to the agents running inside your Suma VM.",
              },
              {
                icon: Bot,
                number: "03",
                title: "Keeps one working memory",
                copy: "A request can begin in Slack and continue on desktop without starting over or losing the thread.",
              },
            ].map(({ icon: Icon, number, title, copy }) => (
              <article
                key={number}
                className="group border-b border-line py-8 md:border-r md:px-8 first:md:pl-0 last:md:border-r-0 last:md:pr-0"
              >
                <div className="flex items-center justify-between">
                  <span className="eyebrow text-muted">{number}</span>
                  <span className="grid size-11 place-items-center border border-line text-violet transition-colors group-hover:border-violet group-hover:bg-violet group-hover:text-white">
                    <Icon className="size-4.5" />
                  </span>
                </div>
                <h3 className="font-display mt-16 max-w-xs text-3xl font-semibold leading-[1.08] tracking-[-0.025em]">
                  {title}
                </h3>
                <p className="mt-4 max-w-sm text-sm leading-6 text-muted">
                  {copy}
                </p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section
        id="channels"
        className="bg-ink px-5 py-24 text-white sm:px-8 lg:px-12 lg:py-32"
      >
        <div className="mx-auto max-w-[1344px]">
          <div className="grid items-end gap-10 lg:grid-cols-2">
            <div>
              <p className="eyebrow text-coral">Call Gala from anywhere</p>
              <h2 className="font-display mt-5 max-w-2xl text-[clamp(3.4rem,5.6vw,6rem)] font-semibold leading-[1] tracking-[-0.045em]">
                Same Gala.
                <span className="block text-[#8ba3ff]">Different door.</span>
              </h2>
            </div>
            <p className="max-w-lg text-base leading-7 text-white/60 lg:justify-self-end lg:pb-2">
              Connect the conversations you already live in. Every channel is
              identity-linked, policy-bound, and independently revocable.
            </p>
          </div>
          <div className="mt-16 grid gap-3 md:grid-cols-3">
            {channels.map(
              ({ name, note, icon: Icon, style, indexStyle }, index) => (
                <article
                  key={name}
                  className={`group relative min-h-80 overflow-hidden border border-white/15 p-7 ${style}`}
                >
                  <span
                    className={`text-[0.65rem] uppercase tracking-[0.16em] ${indexStyle}`}
                  >
                    0{index + 1}
                  </span>
                  <Grid3X3 className="absolute right-6 top-6 size-7 opacity-60" />
                  <div className="absolute inset-x-7 bottom-7">
                    <Icon className="mb-10 size-8" strokeWidth={1.5} />
                    <h3 className="font-display text-4xl font-semibold">
                      {name}
                    </h3>
                    <p className="mt-2 text-sm opacity-60">{note}</p>
                  </div>
                </article>
              ),
            )}
          </div>
        </div>
      </section>

      <section
        id="trust"
        className="bg-cream px-5 py-24 sm:px-8 lg:px-12 lg:py-32"
      >
        <div className="mx-auto grid max-w-[1344px] gap-12 bg-coral p-7 text-white sm:p-12 lg:grid-cols-[1.2fr_0.8fr] lg:p-16">
          <div>
            <ShieldCheck className="size-10" strokeWidth={1.5} />
            <h2 className="font-display mt-12 max-w-3xl text-[clamp(3.2rem,5.2vw,5.7rem)] font-semibold leading-[1] tracking-[-0.045em]">
              Your accounts. Your rules. Your final say.
            </h2>
          </div>
          <div className="flex flex-col justify-end lg:pl-8">
            <p className="text-base leading-7 text-white/78">
              Gala can be powerful because access is explicit. Choose which
              tools each channel may use, inspect activity, revoke links, and
              keep credentials inside trusted server-side storage.
            </p>
            <ul className="mt-8 space-y-3 border-t border-white/30 pt-6 text-sm">
              {[
                "Per-channel identity links",
                "Granular tool permissions",
                "Short-lived machine capability tokens",
                "Visible activity and one-click revoke",
              ].map((item) => (
                <li key={item} className="flex items-center gap-3">
                  <span className="grid size-5 place-items-center bg-white text-coral">
                    <Check className="size-3" />
                  </span>
                  {item}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <footer className="border-t border-line bg-white px-5 py-8 sm:px-8 lg:px-12">
        <div className="mx-auto flex max-w-[1344px] flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
          <GalaMark />
          <p className="text-xs text-muted">
            An external doorway into your Suma agent.
          </p>
          <div className="flex items-center gap-2 text-xs text-muted">
            <LockKeyhole className="size-3.5" />
            Built for deliberate access
          </div>
        </div>
      </footer>
    </main>
  );
}
