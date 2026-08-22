"use client";

import {
  Check,
  CircleDot,
  Globe2,
  Hash,
  MemoryStick,
  MousePointer2,
  SquareTerminal,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type AnimationEvent } from "react";

import { Button } from "@/components/ui/button";

type CardId = "incoming" | "working" | "active";
type StackPhase = "idle" | "settling" | "shuffling";

const initialOrder: CardId[] = ["incoming", "working", "active"];
const cardLabels: Record<CardId, string> = {
  incoming: "Incoming request",
  working: "Working context",
  active: "Active run",
};

const incomingChecks = [
  ["Identity", "Verified"],
  ["Tool policy", "8 groups"],
  ["Thread", "Attached"],
] as const;

const workingTools: ReadonlyArray<{
  detail: string;
  icon: LucideIcon;
  label: string;
  width: string;
}> = [
  {
    label: "Browser",
    detail: "Reading launch metrics",
    icon: MousePointer2,
    width: "w-[88%]",
  },
  {
    label: "Terminal",
    detail: "Updating the brief",
    icon: SquareTerminal,
    width: "w-[68%]",
  },
  {
    label: "Memory",
    detail: "Thread context attached",
    icon: MemoryStick,
    width: "w-full",
  },
];

function IncomingCard() {
  return (
    <>
      <span
        className="absolute -bottom-24 -right-5 font-display text-[19rem] font-bold leading-none text-white/10"
        aria-hidden="true"
      >
        →
      </span>
      <div className="relative z-10">
        <div className="flex items-start justify-between gap-5">
          <p className="font-display text-xl font-semibold leading-[1.05] sm:text-2xl">
            Incoming
            <br />
            request
          </p>
          <div className="grid grid-cols-2 gap-1.5" aria-hidden="true">
            {[0, 1, 2, 3].map((index) => (
              <span key={index} className="size-3 rounded-full bg-white" />
            ))}
          </div>
        </div>

        <div className="hero-grid-fade mt-4 h-[3.4rem] opacity-40 sm:ml-12" />
        <div className="mt-4 flex items-center gap-2 text-[0.6rem] uppercase tracking-[0.14em] text-white/75">
          <Hash className="size-4" />
          Slack · #launch
        </div>
        <p className="font-display mt-3 max-w-md text-[clamp(1.05rem,2vw,1.4rem)] font-semibold leading-[1.1] tracking-[-0.02em]">
          “Pull tomorrow’s launch metrics, update the brief, and send the team a
          concise summary.”
        </p>

        <div className="mt-5">
          <div className="flex items-center justify-between text-[0.52rem] font-semibold uppercase tracking-[0.1em] text-white/65">
            <span>Request routing</span>
            <span>3 checks</span>
          </div>
          <div className="mt-2 h-2 overflow-hidden bg-white/20">
            <span
              className="incoming-route-fill block h-full bg-white"
              data-testid="incoming-route-fill"
            />
          </div>
        </div>

        <div className="mt-5 space-y-2 text-[0.65rem] sm:text-xs">
          {incomingChecks.map(([label, value], index) => (
            <div
              key={label}
              className={`incoming-check incoming-check-${index + 1} flex items-center justify-between border-b border-white/25 pb-2 last:border-b-0`}
            >
              <span className="flex items-center gap-2">
                <span className="grid size-4 place-items-center border border-white/50">
                  <Check className="size-2.5" />
                </span>
                {label}
              </span>
              <span className="text-white/65">{value}</span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function WorkingCard() {
  return (
    <>
      <span
        className="absolute -bottom-20 -right-5 font-display text-[19rem] font-bold leading-none text-white/8"
        aria-hidden="true"
      >
        G
      </span>
      <div className="relative z-10">
        <div className="flex items-start justify-between gap-5">
          <p className="font-display text-xl font-semibold leading-[1.05] sm:text-2xl">
            Working
            <br />
            context
          </p>
          <Globe2 className="size-6 text-white/65" />
        </div>

        <div className="hero-grid-fade mt-4 h-[3.4rem] opacity-30 sm:ml-12" />
        <div className="mt-4 flex items-center gap-2 text-[0.6rem] uppercase tracking-[0.14em] text-coral">
          <CircleDot className="working-context-pulse size-4" />
          Live orchestration
        </div>
        <p className="font-display mt-3 text-[clamp(1.6rem,3.4vw,2.8rem)] font-semibold leading-[0.98] tracking-[-0.035em]">
          3 tools
          <span className="block text-white/45">in one thread.</span>
        </p>
        <p className="mt-3 max-w-sm text-[0.62rem] leading-4 text-white/55 sm:text-xs sm:leading-5">
          Gala keeps the browser, terminal, and conversation memory aligned
          while the request moves forward.
        </p>

        <div className="mt-5 space-y-3">
          {workingTools.map(({ label, detail, icon: Icon, width }, index) => (
            <div key={label} className="grid grid-cols-[1.15rem_1fr] gap-2.5">
              <Icon className="mt-0.5 size-4 text-coral" />
              <div>
                <div className="flex items-center justify-between gap-3 text-[0.58rem] sm:text-[0.68rem]">
                  <span>{label}</span>
                  <span className="truncate text-white/45">{detail}</span>
                </div>
                <div className="mt-1.5 h-1 overflow-hidden bg-white/15">
                  <span
                    className={`working-context-bar working-context-bar-${index + 1} block h-full ${width} bg-coral`}
                    data-testid={
                      index === 0 ? "working-context-bar" : undefined
                    }
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function ActiveCard() {
  return (
    <>
      <div className="flex items-start justify-between gap-6">
        <p className="font-display text-xl font-semibold leading-[1.05] sm:text-2xl">
          Active
          <br />
          run
        </p>
        <div className="grid grid-cols-2 gap-1.5" aria-hidden="true">
          {[0, 1, 2, 3].map((index) => (
            <span key={index} className="size-3 rounded-full bg-ink" />
          ))}
        </div>
      </div>
      <div className="hero-grid-fade mt-4 h-[4.5rem] opacity-65 sm:ml-12" />
      <div className="mt-4 flex items-center gap-2 text-[0.6rem] uppercase tracking-[0.14em] text-coral">
        <CircleDot className="size-4" />
        Gala is working
      </div>
      <p className="mt-3 text-xs text-muted">Launch brief · remote workspace</p>
      <p className="font-display mt-1 text-[clamp(3.3rem,6vw,5.75rem)] font-semibold leading-none tracking-[-0.04em]">
        7<span className="text-line">/8</span>
      </p>
      <div
        className="mt-3"
        data-testid="active-run-progress"
        role="progressbar"
        aria-label="Run progress"
        aria-valuemin={0}
        aria-valuemax={8}
        aria-valuenow={7}
      >
        <div className="relative pt-4">
          <span className="run-progress-label absolute top-0 text-[0.43rem] font-bold uppercase leading-[0.9] tracking-[0.05em] text-violet">
            Current
            <br />
            step
          </span>
          <div className="run-progress-remaining relative h-7 overflow-hidden">
            <span
              className="run-progress-fill absolute inset-y-0 left-0 w-[87.5%] bg-coral"
              data-testid="active-run-progress-fill"
            />
          </div>
          <span className="run-progress-marker absolute bottom-[-0.28rem] top-2 w-px bg-coral" />
        </div>
        <div className="mt-2.5 flex items-center gap-2 text-[0.48rem] font-semibold uppercase tracking-[0.04em] text-violet">
          <span>Start</span>
          <span className="h-px flex-1 bg-violet/55" />
          <span>Done</span>
        </div>
      </div>
      <div className="mt-4 space-y-2.5 text-[0.65rem] sm:text-xs">
        <div className="flex items-center justify-between border-b border-line pb-2">
          <span>Browser session</span>
          <span className="text-violet">Connected</span>
        </div>
        <div className="flex items-center justify-between border-b border-line pb-2">
          <span>Terminal checks</span>
          <span className="text-violet">Passed</span>
        </div>
        <div className="flex items-center justify-between">
          <span>Final handoff</span>
          <span className="text-coral">Running</span>
        </div>
      </div>
    </>
  );
}

function CardContent({ card }: { card: CardId }) {
  if (card === "incoming") return <IncomingCard />;
  if (card === "working") return <WorkingCard />;
  return <ActiveCard />;
}

export function HeroCardStack() {
  const [order, setOrder] = useState<CardId[]>(initialOrder);
  const [phase, setPhase] = useState<StackPhase>("idle");
  const settleFrame = useRef<number | null>(null);
  const frontCard = order[2] ?? "active";
  const shuffling = phase !== "idle";

  useEffect(
    () => () => {
      if (settleFrame.current !== null) {
        cancelAnimationFrame(settleFrame.current);
      }
    },
    [],
  );

  function shuffle() {
    if (phase === "idle") setPhase("shuffling");
  }

  function finishShuffle(event: AnimationEvent<HTMLElement>) {
    if (phase !== "shuffling" || event.target !== event.currentTarget) return;
    setOrder((current) => [current[2]!, current[0]!, current[1]!]);
    setPhase("settling");

    // Commit the reordered neutral stack before restoring its hovered pose.
    // Two frames ensure the browser has a distinct transition start value.
    settleFrame.current = requestAnimationFrame(() => {
      settleFrame.current = requestAnimationFrame(() => {
        settleFrame.current = null;
        setPhase("idle");
      });
    });
  }

  return (
    <div
      className="agent-stack w-full max-w-[772px] lg:translate-x-2"
      aria-label="Gala working across messages, browser, and terminal"
      data-shuffling={shuffling}
      data-stack-phase={phase}
      data-testid="hero-card-stack"
    >
      {order.map((card, slot) => (
        <article
          key={card}
          className={`agent-stack-card agent-stack-slot-${slot} ${
            card === "incoming"
              ? "bg-coral p-5 text-white sm:p-6"
              : card === "working"
                ? "bg-ink p-5 text-white sm:p-6"
                : "bg-white p-5 text-ink sm:p-7"
          }`}
          data-card={card}
          data-slot-index={slot}
          data-testid={`hero-card-${card}`}
          onAnimationEnd={slot === 2 ? finishShuffle : undefined}
        >
          <CardContent card={card} />
        </article>
      ))}

      <Button
        type="button"
        variant="bare"
        size="none"
        aria-label={`Shuffle cards. Currently showing ${cardLabels[frontCard]}.`}
        className="absolute inset-0 z-50 size-full cursor-pointer rounded-[1.375rem] focus-visible:ring-white/80 disabled:cursor-wait"
        data-testid="hero-card-shuffle"
        disabled={shuffling}
        onClick={shuffle}
      >
        <span className="sr-only">Reveal the next card</span>
      </Button>
      <span className="sr-only" aria-live="polite">
        Showing {cardLabels[frontCard]}
      </span>
    </div>
  );
}
