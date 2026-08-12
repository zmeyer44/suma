import type { Metadata } from "next";
import Link from "next/link";

import { Reveal } from "@/components/reveal";
import { Card, Shell } from "@/components/section";
import { SumaMark } from "@/components/suma-mark";

export const metadata: Metadata = {
  title: "Download",
  description:
    "Get Suma for macOS. One disk image, one drag to Applications — sign in and your spaces, tabs and sign-ins are already there.",
};

/** The route handler that 302s to the current DMG (see ./macos/route.ts). */
const DOWNLOAD_HREF = "/download/macos";

const STEPS = [
  [
    "01",
    "Open the disk image",
    "Suma downloads as a .dmg. Open it and the install window appears.",
  ],
  [
    "02",
    "Drag Suma to Applications",
    "The arrow shows the way. That drag is the whole install.",
  ],
  [
    "03",
    "Open Suma and sign in",
    "Your spaces, tabs and sign-ins are already on the desk. Pick up where you left off.",
  ],
] as const;

export default function DownloadPage() {
  return (
    <div className="pb-6 pt-32 sm:pt-40">
      <Shell>
        {/* The ask and the act, side by side: headline and button on the left,
            the install ritual — the DMG window, re-set in the page's own
            material — on the right. */}
        <Reveal className="grid gap-x-16 gap-y-12 lg:grid-cols-12 lg:items-end">
          <div className="min-w-0 lg:col-span-6">
            <p className="label">
              <span className="text-royal">Download</span>
              <span className="px-2 opacity-30">—</span>
              macOS
            </p>
            <h1 className="display mt-6 max-w-[12ch] text-[clamp(2.75rem,7vw,6rem)] uppercase">
              Put your desk on this Mac.
            </h1>
            <p className="mt-8 max-w-[44ch] text-[1.0625rem] leading-[1.6] text-muted-foreground">
              One download. Every page renders locally, at full speed — and from
              the moment you sign in, your spaces, tabs and sign-ins follow you
              to any machine you sit down at.
            </p>

            <div className="mt-10 flex flex-wrap items-center gap-x-6 gap-y-4">
              <a
                href={DOWNLOAD_HREF}
                data-pixel="control"
                className="group inline-flex items-center gap-3 rounded-full bg-ink px-7 py-4 text-[1rem] font-medium text-paper transition-colors hover:bg-royal"
              >
                Download for macOS
                <span
                  aria-hidden
                  className="transition-transform duration-300 group-hover:translate-y-0.5"
                >
                  ↓
                </span>
              </a>
              <p className="label">
                macOS 14+ · Apple Silicon · Free during the beta
              </p>
            </div>
          </div>

          {/* The DMG window as it will actually open, rebuilt from the same
              three parts as the shipped background: two landing spots and one
              royal arrow between them. Decorative — the real one is in the
              download. */}
          <div className="min-w-0 lg:col-span-6" aria-hidden>
            <Card tone="royal" className="p-4 sm:p-6">
              <div className="rounded-lg bg-paper text-ink">
                <div className="flex items-center gap-2 px-5 pt-4">
                  <span className="size-2.5 rounded-full bg-ink/15" />
                  <span className="size-2.5 rounded-full bg-ink/15" />
                  <span className="size-2.5 rounded-full bg-ink/15" />
                  <span className="label ml-3 !text-[0.5625rem]">Suma</span>
                </div>

                <p className="label pt-6 text-center !text-[0.625rem] text-royal">
                  Drag to Applications
                </p>

                <div className="flex items-center justify-center gap-6 px-6 pb-10 pt-6 sm:gap-10">
                  <div className="flex flex-col items-center gap-3">
                    <span className="flex size-20 items-center justify-center rounded-[22%] bg-royal sm:size-24">
                      <SumaMark className="h-9 w-auto text-paper sm:h-11" />
                    </span>
                    <span className="font-mono text-[0.625rem] text-muted-foreground">
                      Suma.app
                    </span>
                  </div>

                  <span className="display text-[2rem] text-royal sm:text-[2.5rem]">
                    →
                  </span>

                  <div className="flex flex-col items-center gap-3">
                    <span className="flex size-20 items-center justify-center rounded-[22%] bg-surface-deep sm:size-24">
                      <svg
                        viewBox="0 0 24 24"
                        className="h-9 w-auto text-muted-foreground sm:h-11"
                        fill="currentColor"
                      >
                        <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.55c.4 0 .78.16 1.06.44l1.4 1.4c.29.28.67.44 1.07.44h6.92A1.5 1.5 0 0 1 21 8.78v9.22a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18V6.5Z" />
                      </svg>
                    </span>
                    <span className="font-mono text-[0.625rem] text-muted-foreground">
                      Applications
                    </span>
                  </div>
                </div>
              </div>
            </Card>
          </div>
        </Reveal>

        {/* The whole install, spelled out — three moves, none of them setup. */}
        <div className="mt-16 grid gap-3 sm:grid-cols-3 lg:mt-24">
          {STEPS.map(([index, title, body], i) => (
            <Reveal key={index} delay={i * 90}>
              <Card tone="surface" className="h-full">
                <p className="label">
                  <span className="text-royal">{index}</span>
                </p>
                <h2 className="display mt-16 text-[1.375rem] uppercase leading-[1.05] sm:mt-20">
                  {title}
                </h2>
                <p className="mt-3 text-[0.9375rem] leading-[1.55] text-muted-foreground">
                  {body}
                </p>
              </Card>
            </Reveal>
          ))}
        </div>

        {/* The page ends the way the landing page does: on a surface. */}
        <Reveal className="mt-3">
          <Card
            tone="ink"
            className="flex flex-col gap-x-16 gap-y-8 sm:flex-row sm:items-end sm:justify-between"
          >
            <div className="min-w-0">
              <p className="font-mono text-[0.6875rem] uppercase tracking-[0.16em] text-paper/45">
                Not on a Mac?
              </p>
              <p className="display mt-5 max-w-[24ch] text-[clamp(1.5rem,2.6vw,2.25rem)] uppercase">
                Windows and Linux are on the bench.
              </p>
              <p className="mt-4 max-w-[46ch] text-[0.9375rem] leading-[1.6] text-paper/60">
                Suma ships on macOS first. Leave an address and we&rsquo;ll send
                the build for your machine the day it lands.
              </p>
            </div>
            <Link
              href="/#access"
              data-pixel="control"
              className="group inline-flex shrink-0 items-center gap-2.5 self-start rounded-full bg-paper px-6 py-3.5 text-[0.9375rem] font-medium text-ink transition-colors hover:bg-royal hover:text-paper sm:self-auto"
            >
              Join the list
              <span
                aria-hidden
                className="transition-transform duration-300 group-hover:translate-x-1"
              >
                →
              </span>
            </Link>
          </Card>
        </Reveal>
      </Shell>
    </div>
  );
}
