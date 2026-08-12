"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { Reveal } from "@/components/reveal";
import { SectionHead, Shell } from "@/components/section";
import { cn } from "@/lib/utils";

/**
 * One line each, and the clip does the rest. Everything these five used to say
 * in paragraphs is now something you watch happen.
 *
 * `dwell` is how long the selection holds before moving on, in seconds. Every
 * clip loops, so a short one plays twice rather than flashing past.
 */
const FEATURES = [
  {
    key: "split-view",
    name: "Split view",
    body: "Drop a tab beside another and work in both at once.",
    dwell: 14.6,
  },
  {
    key: "assistant",
    name: "Assistant",
    body: "Ask about the page you are on, without leaving it.",
    dwell: 13,
  },
  {
    key: "read-aloud",
    name: "Read aloud",
    body: "Select a passage and Suma reads it while you keep browsing.",
    dwell: 14.5,
  },
  {
    key: "terminal",
    name: "Terminal & IDE",
    body: "A real shell, file explorer and editor, in a tab.",
    dwell: 6.6,
  },
  {
    key: "signer",
    name: "Nostr, built in",
    body: "Sign in to Nostr apps with a key that never leaves this Mac.",
    dwell: 14.6,
  },
] as const;

export function Features() {
  const [active, setActive] = useState(0);
  const [still, setStill] = useState(false);

  const videosRef = useRef<(HTMLVideoElement | null)[]>([]);
  const barsRef = useRef<(HTMLSpanElement | null)[]>([]);
  const stageRef = useRef<HTMLDivElement | null>(null);
  // Set by the observer below before anything plays, so a page that opens
  // well above this section never starts a decoder.
  const visibleRef = useRef(false);

  // Reduced motion holds every clip on its poster; the list still switches, so
  // the section works as a set of stills rather than not at all.
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setStill(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  /** Plays the selected clip from the top and parks every other one. */
  const play = useCallback(() => {
    barsRef.current.forEach((bar, index) => {
      if (bar && index !== active) bar.style.transform = "scaleX(0)";
    });

    videosRef.current.forEach((video, index) => {
      if (!video) return;
      if (index !== active) {
        video.pause();
        return;
      }
      if (still || !visibleRef.current) return;
      video.currentTime = 0;
      void video.play().catch(() => {});
    });
  }, [active, still]);

  useEffect(play, [play]);

  /**
   * The selection runs on its own clock rather than on the clip's, so a short
   * loop can play twice before the list moves on. The frame writes the active
   * item's rule straight to the DOM — none of it needs a render.
   */
  useEffect(() => {
    if (still) return;

    const dwell = (FEATURES[active]?.dwell ?? 10) * 1000;
    let start = performance.now();
    let frame = 0;

    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);

      // Time spent off-screen doesn't count against the dwell.
      if (!visibleRef.current) {
        start = now;
        return;
      }

      const fraction = (now - start) / dwell;
      const bar = barsRef.current[active];
      if (bar) bar.style.transform = `scaleX(${Math.min(1, fraction)})`;
      if (fraction >= 1) setActive((index) => (index + 1) % FEATURES.length);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [active, still]);

  // Nothing plays off-screen — five decoders running under the footer is a lot
  // of battery for something nobody is looking at.
  useEffect(() => {
    const node = stageRef.current;
    if (!node) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        const visible = entry?.isIntersecting ?? false;
        visibleRef.current = visible;
        if (visible) play();
        else videosRef.current.forEach((video) => video?.pause());
      },
      { threshold: 0.15 },
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, [play]);

  return (
    <section id="features" className="scroll-mt-24">
      <Shell>
        <SectionHead
          index="01"
          label="Features"
          title={<>Everything, without the extensions.</>}
        />

        <Reveal delay={80}>
          <p className="max-w-[46ch] pb-10 text-[1.125rem] leading-[1.6] text-muted-foreground">
            The parts you would otherwise bolt on one add-on at a time, built
            into the browser and shown here exactly as they ship.
          </p>
        </Reveal>

        <div className="flex flex-col gap-6 pb-20 lg:flex-row lg:items-start lg:gap-10 lg:pb-28">
          {/* Under lg the list collapses to a scrolling strip of names, with
              the selected one's line moved beneath the clip. */}
          <div className="lg:w-[30%] lg:shrink-0">
            <div className="-mx-5 flex gap-2 overflow-x-auto px-5 pb-1 lg:hidden">
              {FEATURES.map((feature, index) => (
                <button
                  key={feature.key}
                  type="button"
                  onClick={() => setActive(index)}
                  aria-pressed={index === active}
                  data-pixel="control"
                  className={cn(
                    "shrink-0 whitespace-nowrap rounded-full px-4 py-2.5 text-[0.875rem] font-medium transition-colors",
                    index === active
                      ? "bg-ink text-paper"
                      : "bg-surface text-muted-foreground",
                  )}
                >
                  {feature.name}
                </button>
              ))}
            </div>

            <ul className="hidden lg:flex lg:flex-col lg:gap-1">
              {FEATURES.map((feature, index) => {
                const selected = index === active;
                return (
                  <li key={feature.key}>
                    <button
                      type="button"
                      onClick={() => setActive(index)}
                      aria-pressed={selected}
                      data-pixel="card"
                      className={cn(
                        "w-full rounded-xl px-5 py-4 text-left transition-colors duration-300",
                        selected ? "bg-surface" : "hover:bg-surface/50",
                      )}
                    >
                      <span className="display block text-[1.375rem] leading-none">
                        {feature.name}
                      </span>
                      <span
                        className={cn(
                          "mt-2.5 block text-[0.9375rem] leading-[1.5] transition-colors duration-300",
                          selected
                            ? "text-muted-foreground"
                            : "text-muted-foreground/55",
                        )}
                      >
                        {feature.body}
                      </span>
                      <span
                        aria-hidden
                        className={cn(
                          "mt-4 block h-px w-full bg-ink/10 transition-opacity duration-300",
                          selected ? "opacity-100" : "opacity-0",
                        )}
                      >
                        <span
                          ref={(node) => {
                            barsRef.current[index] = node;
                          }}
                          className="block h-px w-full origin-left scale-x-0 bg-royal"
                        />
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>

          {/* The clips share one plate and cross-fade in place, so the section
              never jumps height as the selection moves. */}
          <div ref={stageRef} className="min-w-0 flex-1">
            <div
              data-pixel="card"
              className="relative aspect-[1280/824] overflow-hidden rounded-2xl bg-surface p-2 sm:rounded-3xl sm:p-3"
            >
              {FEATURES.map((feature, index) => (
                <video
                  key={feature.key}
                  ref={(node) => {
                    videosRef.current[index] = node;
                  }}
                  src={`/media/${feature.key}/video.mp4`}
                  poster={`/media/${feature.key}/poster.jpg`}
                  muted
                  loop
                  playsInline
                  preload={index === active ? "auto" : "none"}
                  aria-label={`${feature.name} — ${feature.body}`}
                  className={cn(
                    "absolute inset-2 h-[calc(100%-1rem)] w-[calc(100%-1rem)] rounded-lg object-cover transition-[opacity,transform] duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] sm:inset-3 sm:h-[calc(100%-1.5rem)] sm:w-[calc(100%-1.5rem)] sm:rounded-xl",
                    index === active
                      ? "scale-100 opacity-100"
                      : "pointer-events-none scale-[0.98] opacity-0",
                  )}
                />
              ))}
            </div>

            <p className="mt-4 text-[0.9375rem] leading-[1.5] text-muted-foreground lg:hidden">
              {FEATURES[active]?.body}
            </p>
          </div>
        </div>
      </Shell>
    </section>
  );
}
