"use client";

import { useCallback, useRef, useState } from "react";

import { PixelMosaic } from "@/components/pixel-mosaic";
import { Shell } from "@/components/section";
import { cn } from "@/lib/utils";

/**
 * Cursor work needed to fill the meter once, in cell-widths of mean
 * displacement × seconds. Tuned so a deliberate scrub through the mark fills
 * it in a few seconds and a pointer merely crossing the cell barely registers.
 */
const FILL_COST = 1.6;

/**
 * Disturbance below this is the spring's own residue, not the cursor. Without
 * it the meter would creep to full on an untouched page.
 */
const NOISE_FLOOR = 0.01;

/** Input ignored for this long after a flip, so one scrub cannot flip twice. */
const COOLDOWN_MS = 700;

/**
 * The hero reads on two grounds: paper by default, royal once the mark has
 * been scattered hard enough to fill the meter. Every colour that has to
 * survive that swap is named here rather than inline, so the two states stay
 * in step.
 */
const TONES = {
  paper: {
    section: "bg-transparent",
    rule: "border-border",
    label: "text-muted-foreground",
    word: "text-royal",
    box: "bg-royal text-paper",
    boxTag: "text-paper/60",
    track: "bg-paper/30",
    fill: "bg-paper",
    link: "text-muted-foreground hover:text-foreground",
    pill: "border-ink hover:border-royal hover:bg-royal hover:text-paper",
  },
  royal: {
    section: "bg-royal",
    rule: "border-paper/25",
    label: "text-paper/60",
    word: "text-paper",
    box: "bg-paper text-royal",
    boxTag: "text-royal-deep/60",
    track: "bg-royal/20",
    fill: "bg-royal",
    link: "text-paper/70 hover:text-paper",
    pill: "border-paper text-paper hover:bg-paper hover:text-royal",
  },
} as const;

export function Hero() {
  const [inverted, setInverted] = useState(false);

  const barRef = useRef<HTMLDivElement | null>(null);
  const readoutRef = useRef<HTMLSpanElement | null>(null);
  const progressRef = useRef(0);
  const lastFrameRef = useRef(0);
  const lockedUntilRef = useRef(0);

  /**
   * Integrates disturbance into the meter. Runs every animation frame, so it
   * writes the bar through the DOM and only re-renders on the flip itself.
   */
  const onDisturbance = useCallback((intensity: number) => {
    const now = performance.now();
    const previous = lastFrameRef.current;
    lastFrameRef.current = now;

    if (now < lockedUntilRef.current) return;
    if (intensity < NOISE_FLOOR) return;
    // No usable delta on the first frame after a gap in reporting.
    if (previous === 0) return;

    const seconds = Math.min(0.05, (now - previous) / 1000);
    const next = Math.min(
      1,
      progressRef.current + (intensity * seconds) / FILL_COST,
    );
    progressRef.current = next;

    const filled = next >= 1;
    if (filled) {
      progressRef.current = 0;
      lockedUntilRef.current = now + COOLDOWN_MS;
      setInverted((value) => !value);
    }

    const shown = filled ? 0 : next;
    if (barRef.current) barRef.current.style.width = `${shown * 100}%`;
    if (readoutRef.current) {
      readoutRef.current.textContent = `${String(Math.round(shown * 100)).padStart(2, "0")}%`;
    }
  }, []);

  const tone = inverted ? TONES.royal : TONES.paper;

  return (
    <section
      className={cn(
        "pt-24 transition-colors duration-700 sm:pt-28",
        tone.section,
      )}
    >
      <Shell>
        <div
          className={cn(
            "grid border-y transition-colors duration-700 lg:grid-cols-12",
            tone.rule,
          )}
        >
          {/* Left plate — the mark, assembling out of its own pixels and
              scattering under the cursor. Scattering it is also the input
              that drives the meter in the readout opposite.

              Stacked, it drops below the wordmark: the reader should meet the
              name before the ornament. `order` is safe to use here because
              neither cell holds anything focusable. */}
          <div
            className={cn(
              "relative order-2 transition-colors duration-700 lg:order-1 lg:col-span-5 lg:border-r",
              tone.rule,
            )}
          >
            <p
              className={cn(
                "label absolute left-0 top-0 pt-4 transition-colors duration-700",
                tone.label,
              )}
            >
              Object / the mark — scatter it
            </p>
            <PixelMosaic
              className="block h-[clamp(20rem,36vw,32rem)] w-full"
              inverted={inverted}
              onDisturbance={onDisturbance}
            />
          </div>

          {/* Right plate — caption and readout across the top, the wordmark
              set as large as the cell will carry underneath. */}
          <div
            className={cn(
              "order-1 flex flex-col border-b pb-6 transition-colors duration-700 lg:order-2 lg:col-span-7 lg:border-b-0 lg:pb-0 lg:pl-8",
              tone.rule,
            )}
          >
            <div className="flex flex-col gap-6 pt-6 sm:flex-row sm:items-start sm:justify-between">
              <p
                className={cn(
                  "max-w-[34ch] text-[0.9375rem] leading-[1.6] transition-colors duration-700",
                  tone.label,
                )}
              >
                Any device, anytime, anywhere
              </p>

              <div
                data-pixel="card"
                className={cn(
                  "shrink-0 px-5 py-4 transition-colors duration-700 sm:w-[18rem]",
                  tone.box,
                )}
              >
                <div className="flex items-start justify-between gap-4">
                  <p className="display max-w-[10ch] text-[clamp(1.25rem,2vw,1.875rem)] uppercase leading-none">
                    Your work follows you
                  </p>
                  <p
                    className={cn(
                      "text-right font-mono text-[0.5625rem] uppercase leading-normal tracking-[0.16em] transition-colors duration-700",
                      tone.boxTag,
                    )}
                  >
                    Suma
                    <br />
                    promise
                  </p>
                </div>

                <div className="mt-5 flex items-center gap-3">
                  <div
                    className={cn(
                      "h-0.75 flex-1 transition-colors duration-700",
                      tone.track,
                    )}
                  >
                    <div
                      ref={barRef}
                      className={cn(
                        "h-0.75 w-0 transition-[width,background-color] duration-150 ease-out",
                        tone.fill,
                      )}
                    />
                  </div>
                  <span
                    ref={readoutRef}
                    className={cn(
                      "font-mono text-[0.5625rem] tabular-nums transition-colors duration-700",
                      tone.boxTag,
                    )}
                  >
                    00%
                  </span>
                </div>
              </div>
            </div>

            {/* Stacked, the wordmark has the full page width to fill; beside
                the mosaic it only has the right cell, so it scales off a
                smaller share of the viewport there. */}
            <h1
              className={cn(
                "display mt-auto block pb-3 pt-10 text-[clamp(3.5rem,30vw,17rem)] font-black uppercase leading-[0.8] tracking-tighter transition-colors duration-700 lg:text-[clamp(3.5rem,18vw,17rem)]",
                tone.word,
              )}
            >
              Suma
            </h1>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-x-8 gap-y-4 py-5">
          <p className={cn("label transition-colors duration-700", tone.label)}>
            Open source · built for productivity · not for ads
          </p>

          <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
            <a
              href="#features"
              className={cn(
                "text-[0.9375rem] transition-colors duration-700",
                tone.link,
              )}
            >
              See what it does
            </a>
            <a
              href="#access"
              data-pixel="control"
              className={cn(
                "group inline-flex items-center gap-2 rounded-full border px-5 py-2 text-[0.875rem] font-medium transition-colors duration-700",
                tone.pill,
              )}
            >
              Get early access
              <span
                aria-hidden
                className="transition-transform duration-300 group-hover:translate-x-1"
              >
                →
              </span>
            </a>
          </div>
        </div>
      </Shell>
    </section>
  );
}
