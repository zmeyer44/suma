import { AppFrame } from "@/components/app-frame";
import { HeroWaitlist } from "@/components/hero-waitlist";
import { Reveal } from "@/components/reveal";
import { Shell } from "@/components/section";

const REPO_URL = "https://github.com/zmeyer44/suma";

/**
 * The claims in the stat row, set as a Swiss stat column: a bare numeral on a
 * thin rule, the sentence it stands for underneath. Every one is checkable —
 * no invented revenue percentages on an open-source browser.
 */
const STATS = [
  ["100%", "Open source — every line of the browser under AGPL-3.0."],
  ["1", "Sign-in — your spaces, tabs and files on any machine."],
  ["0", "Ads, trackers or attention games. Built for work, not for feeds."],
] as const;

/** Lucide dropped its brand marks, so the one brand icon here is local. */
function GithubMark(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 15 15" fill="currentColor" {...props}>
      <path
        d="M7.49933 0.25C3.49635 0.25 0.25 3.49593 0.25 7.50024C0.25 10.703 2.32715 13.4206 5.2081 14.3797C5.57084 14.446 5.70302 14.2222 5.70302 14.0299C5.70302 13.8576 5.69679 13.4019 5.69323 12.797C3.67661 13.235 3.25112 11.825 3.25112 11.825C2.92132 10.9874 2.44599 10.7644 2.44599 10.7644C1.78773 10.3149 2.49584 10.3238 2.49584 10.3238C3.22353 10.375 3.60629 11.0711 3.60629 11.0711C4.25298 12.1788 5.30335 11.8588 5.71638 11.6732C5.78225 11.205 5.96962 10.8854 6.17658 10.7043C4.56675 10.5209 2.87415 9.89918 2.87415 7.12104C2.87415 6.32925 3.15677 5.68257 3.62053 5.17563C3.54576 4.99226 3.29697 4.25521 3.69174 3.25691C3.69174 3.25691 4.30015 3.06196 5.68522 3.99973C6.26337 3.83906 6.8838 3.75895 7.50022 3.75583C8.1162 3.75895 8.73619 3.83906 9.31523 3.99973C10.6994 3.06196 11.3069 3.25691 11.3069 3.25691C11.7026 4.25521 11.4538 4.99226 11.3795 5.17563C11.8441 5.68257 12.1245 6.32925 12.1245 7.12104C12.1245 9.9063 10.4292 10.5192 8.81452 10.6985C9.07444 10.9224 9.30633 11.3648 9.30633 12.0413C9.30633 13.0102 9.29742 13.7922 9.29742 14.0299C9.29742 14.2239 9.42828 14.4496 9.79591 14.3788C12.6746 13.4179 14.75 10.7025 14.75 7.50024C14.75 3.49593 11.5036 0.25 7.49933 0.25Z"
        fillRule="evenodd"
        clipRule="evenodd"
      />
    </svg>
  );
}

/**
 * The hero as a magazine split: the pitch down the left column — eyebrow,
 * headline, working copy, the email capture, a checkable proof line, and the
 * stat row pinned to the bottom edge — against a full-height atmospheric
 * panel on the right with the app floating over it, cropped by the panel's
 * bottom edge.
 */
export function Hero() {
  return (
    <section className="pt-28 sm:pt-32 md:pt-24">
      <Shell>
        {/* The negative right margin walks the grid out of the shell to the
            viewport's edge on desktop, so the panel can run off the page. */}
        <div className="grid gap-y-12 md:min-h-[38rem] md:grid-cols-[52%_48%] md:mr-[calc(50%-50vw)] lg:min-h-[46rem]">
          {/* The pitch. On desktop the column runs the panel's full height,
              with the stat row sitting on its bottom edge. */}
          <div className="flex flex-col md:max-w-[46rem] md:pr-10 md:pt-14 lg:pr-14 lg:pt-16 xl:pr-20 xl:pt-20">
            <Reveal>
              <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[0.9375rem] text-muted-foreground">
                Suma — an open-source browser
                <a
                  href={REPO_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="group font-medium text-foreground underline decoration-ink/30 underline-offset-4 transition-colors hover:decoration-ink"
                >
                  Read the code
                  <span
                    aria-hidden
                    className="ml-1.5 inline-block transition-transform duration-300 group-hover:translate-x-1"
                  >
                    →
                  </span>
                </a>
              </p>

              <h1 className="display mt-8 max-w-[15ch] text-[clamp(2.875rem,4.8vw,4.75rem)] leading-[1.02] tracking-[-0.025em]">
                The browser that remembers where you left off
              </h1>

              <p className="mt-7 max-w-[42ch] text-[1.0625rem] leading-[1.6] text-muted-foreground">
                Sign in once and your spaces, tabs, sign-ins and files follow
                you to any machine — with an always-on cloud computer that
                keeps working after you close the lid.
              </p>
            </Reveal>

            <Reveal delay={120} className="mt-9">
              <HeroWaitlist />

              {/* Where the reference stacks analyst stars, a claim a reader
                  can actually check. */}
              <p className="mt-6 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[0.875rem] text-muted-foreground">
                <GithubMark aria-hidden className="size-4 shrink-0" />
                <span>
                  Free during the beta · macOS 14+ ·{" "}
                  <a
                    href={REPO_URL}
                    target="_blank"
                    rel="noreferrer"
                    className="underline underline-offset-4 transition-colors hover:text-foreground"
                  >
                    AGPL-3.0 on GitHub
                  </a>
                </span>
              </p>
            </Reveal>

            <Reveal delay={160} className="mt-16 md:mt-auto md:pt-16">
              <div className="grid gap-x-8 gap-y-8 sm:grid-cols-3">
                {STATS.map(([figure, sentence]) => (
                  <div key={figure} className="border-l-2 border-ink/15 pl-5">
                    <p className="display text-[clamp(2.25rem,2.8vw,2.875rem)] leading-none">
                      {figure}
                    </p>
                    <p className="mt-3 max-w-[26ch] text-[0.875rem] leading-[1.55] text-muted-foreground">
                      {sentence}
                    </p>
                  </div>
                ))}
              </div>
            </Reveal>
          </div>

          {/* The showcase: a full-height atmospheric field standing in for the
              reference's photograph, the app floating over it and cropped by
              the panel's bottom edge. */}
          <Reveal delay={100} className="relative">
            <div className="atmosphere grain relative h-[26rem] overflow-hidden rounded-2xl sm:h-[32rem] md:absolute md:inset-y-0 md:left-0 md:-right-12 md:h-auto">
              {/* The frame runs past the panel's bottom edge and gets cropped
                  by it; the white card behind it reads as the page continuing
                  below the fold. The desktop right offset holds the frame on
                  screen while the field itself runs off the page. */}
              <div className="absolute inset-x-5 -bottom-8 top-12 z-10 sm:inset-x-9 sm:top-16 md:left-7 md:right-24 md:top-16 lg:left-10 lg:right-28 lg:top-20">
                <div className="h-full overflow-hidden rounded-xl bg-paper-raised shadow-[0_40px_120px_-20px_rgba(10,14,24,0.55)] ring-1 ring-black/10">
                  <AppFrame />
                </div>
              </div>
            </div>
          </Reveal>
        </div>
      </Shell>
    </section>
  );
}
