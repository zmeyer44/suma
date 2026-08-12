import { Check, Download, Plus, Settings, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

type Mode = "portable" | "assisted" | "device-bound";

/**
 * The per-site continuity indicator the shell shows on every tab: filled for
 * a session that restores on its own, solid grey when it needs a touch, hollow
 * when the site insists on a fresh sign-in.
 */
function ContinuityDot({ mode }: { mode: Mode }) {
  return (
    <span
      aria-hidden
      className={cn(
        "size-[5px] shrink-0 rounded-full",
        mode === "portable" && "bg-royal",
        mode === "assisted" && "bg-ink/35",
        mode === "device-bound" && "border border-ink/40",
      )}
    />
  );
}

/** Stand-in favicon: the shell draws a seeded tile when a site has none. */
function Favicon({ tint, letter }: { tint: string; letter: string }) {
  return (
    <span
      className={cn(
        "grid size-3.5 shrink-0 place-items-center rounded-[4px] text-[8px] font-bold text-paper",
        tint,
      )}
    >
      {letter}
    </span>
  );
}

type Tab = {
  title: string;
  host: string;
  mode: Mode;
  tint: string;
  letter: string;
};

const ACTIVE: Tab = {
  title: "Q3 launch — plan",
  host: "notion.so",
  mode: "portable",
  tint: "bg-ink",
  letter: "N",
};

const TABS: Tab[] = [
  {
    title: "Roadmap · this quarter",
    host: "linear.app",
    mode: "portable",
    tint: "bg-royal",
    letter: "L",
  },
  {
    title: "Inbox (3)",
    host: "mail.google.com",
    mode: "portable",
    tint: "bg-ink/70",
    letter: "M",
  },
  {
    title: "Brand refresh — v4",
    host: "figma.com",
    mode: "assisted",
    tint: "bg-ink/45",
    letter: "F",
  },
  {
    title: "Statement · August",
    host: "chase.com",
    mode: "device-bound",
    tint: "bg-ink/30",
    letter: "C",
  },
];

const SPACES = [
  { letter: "W", tint: "bg-royal", active: true },
  { letter: "R", tint: "bg-ink/30" },
  { letter: "T", tint: "bg-ink/25" },
  { letter: "P", tint: "bg-ink/20" },
];

/** Flare radius where the active tab merges into the panel below it. */
const FLARE = 9;

/**
 * The active tab's manila-folder silhouette: rounded top corners and concave
 * flares that dissolve its base into the panel. In the app this is an SVG path
 * (`renderer/src/lib/folder.ts`); here the same shape is two radial-gradient
 * corners, so it stays fluid without measuring anything on the client.
 */
function FolderTab({ tab }: { tab: Tab }) {
  const flare = (side: "left" | "right") => (
    <span
      aria-hidden
      className="pointer-events-none absolute bottom-0 size-[9px]"
      style={{
        [side === "left" ? "left" : "right"]: -FLARE,
        background: `radial-gradient(circle ${FLARE}px at top ${side}, transparent ${FLARE}px, var(--paper-raised) ${FLARE}px)`,
      }}
    />
  );

  return (
    <div className="relative z-10 flex h-10 min-w-0 flex-1 items-center gap-2 rounded-t-[11px] bg-paper-raised px-3 sm:max-w-[260px]">
      {flare("left")}
      {flare("right")}
      <Favicon tint={tab.tint} letter={tab.letter} />
      <span className="min-w-0 flex-1 truncate text-[12.5px]">{tab.title}</span>
      <ContinuityDot mode={tab.mode} />
    </div>
  );
}

function FlatTab({ tab, wide }: { tab: Tab; wide?: boolean }) {
  return (
    <div
      className={cn(
        "mb-2 flex h-8 min-w-0 flex-1 items-center gap-2 rounded-[9px] px-3 text-muted-foreground",
        wide ? "sm:max-w-[220px]" : "sm:max-w-[190px]",
      )}
    >
      <Favicon tint={tab.tint} letter={tab.letter} />
      <span className="min-w-0 flex-1 truncate text-[12.5px]">{tab.title}</span>
      <ContinuityDot mode={tab.mode} />
    </div>
  );
}

function StripButton({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground",
        className,
      )}
    >
      {children}
    </span>
  );
}

/** The page in the active tab — a document, rendered locally like any other. */
function ExamplePage() {
  return (
    <div className="mx-auto max-w-[46rem] px-6 py-8 sm:px-10 sm:py-12">
      <p className="font-mono text-[0.625rem] uppercase tracking-[0.14em] text-muted-foreground">
        Marketing / Q3 launch
      </p>
      <h4 className="display mt-4 text-[1.75rem] leading-none sm:text-[2.25rem]">
        Q3 launch — plan
      </h4>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <span className="flex -space-x-1.5">
          {["bg-royal", "bg-ink/60", "bg-ink/35"].map((tint) => (
            <span
              key={tint}
              className={cn(
                "size-5 rounded-full ring-2 ring-paper-raised",
                tint,
              )}
            />
          ))}
        </span>
        <span className="text-[0.75rem] text-muted-foreground">
          3 editors · updated 12 minutes ago
        </span>
      </div>

      <div className="mt-7 space-y-2.5">
        <p className="text-[0.9375rem] leading-[1.7] text-muted-foreground">
          Everything ships the week of the 14th. Pricing goes live first, then
          the announcement, then the walkthrough video.
        </p>
      </div>

      <div className="mt-7 space-y-2">
        {[
          { done: true, text: "Lock the launch date" },
          { done: true, text: "Brief the design team" },
          { done: false, text: "Ship the pricing page" },
          { done: false, text: "Record the walkthrough" },
        ].map((item) => (
          <div key={item.text} className="flex items-center gap-3">
            <span
              className={cn(
                "grid size-[15px] shrink-0 place-items-center rounded-[4px]",
                item.done ? "bg-royal" : "border border-ink/20",
              )}
            >
              {item.done ? (
                <Check
                  className="size-2.5"
                  stroke="var(--paper)"
                  strokeWidth={2.5}
                  aria-hidden
                />
              ) : null}
            </span>
            <span
              className={cn(
                "text-[0.9375rem]",
                item.done ? "text-muted-foreground line-through" : "",
              )}
            >
              {item.text}
            </span>
          </div>
        ))}
      </div>

      <div className="mt-8 rounded-lg bg-royal/[0.07] px-5 py-4">
        <p className="text-[0.875rem] leading-[1.6] text-royal-deep">
          Assets are in Files — 4.9 GB, fetched in the cloud overnight.
        </p>
      </div>
    </div>
  );
}

/**
 * The Suma shell as it actually is: one titlebar strip carrying the tabs, the
 * active tab shaped like a folder so it reads as the front of the panel, and
 * spaces as chips at the right end. There is no sidebar — the page gets the
 * whole window.
 */
export function AppFrame() {
  return (
    <div className="overflow-hidden rounded-lg bg-paper-raised sm:rounded-xl">
      <div className="relative flex h-12 items-end bg-gradient-to-b from-surface-deep to-surface">
        {/* Where macOS puts the traffic lights; the strip reserves the space. */}
        <span className="absolute left-4 top-1/2 flex -translate-y-1/2 gap-2">
          <span className="size-[10px] rounded-full bg-ink/15" />
          <span className="size-[10px] rounded-full bg-ink/15" />
          <span className="size-[10px] rounded-full bg-ink/15" />
        </span>

        <div className="flex min-w-0 flex-1 items-end gap-1.5 pl-[72px] pr-2.5">
          <div className="flex min-w-0 flex-1 items-end">
            <FolderTab tab={ACTIVE} />
            {TABS.map((tab, index) => (
              <span
                key={tab.host}
                className={cn(
                  "flex min-w-0 flex-1",
                  index === 0 ? "ml-[9px]" : "",
                  index > 0 ? "hidden md:flex" : "",
                  index > 2 ? "xl:flex" : "",
                )}
              >
                <FlatTab tab={tab} wide={index === 0} />
              </span>
            ))}
            <span className="mb-2 ml-1 grid size-8 shrink-0 place-items-center rounded-[9px] text-muted-foreground">
              <Plus className="size-3.5" aria-hidden />
            </span>
          </div>

          <div className="mb-2 hidden h-8 shrink-0 items-center gap-1.5 sm:flex">
            <span className="flex items-center gap-1.5 rounded-full bg-ink/[0.06] px-2.5 py-1 font-mono text-[0.5625rem] uppercase tracking-[0.1em] text-muted-foreground">
              <span className="size-1.5 rounded-full bg-royal" />
              3 devices
            </span>

            <StripButton className="text-royal">
              <Sparkles className="size-3.5" aria-hidden />
            </StripButton>
            <StripButton>
              <Download className="size-3.5" aria-hidden />
            </StripButton>
            <StripButton>
              <Settings className="size-3.5" aria-hidden />
            </StripButton>

            <span aria-hidden className="mx-0.5 h-4 w-px bg-ink/10" />

            {SPACES.map((space) => (
              <span
                key={space.letter}
                className={cn(
                  "grid size-[20px] shrink-0 place-items-center rounded-full text-[9.5px] font-bold text-paper",
                  space.tint,
                  space.active
                    ? "scale-110 ring-2 ring-ink/25 ring-offset-2 ring-offset-surface"
                    : "opacity-70",
                )}
              >
                {space.letter}
              </span>
            ))}
            <span className="grid size-[20px] shrink-0 place-items-center rounded-full border border-dashed border-ink/25 text-muted-foreground">
              <Plus className="size-2.5" aria-hidden />
            </span>
          </div>
        </div>
      </div>

      <ExamplePage />
    </div>
  );
}
