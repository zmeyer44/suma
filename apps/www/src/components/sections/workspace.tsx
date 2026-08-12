import { AppFrame } from "@/components/app-frame";
import { Reveal } from "@/components/reveal";
import { Card, SectionHead, Shell } from "@/components/section";
import { cn } from "@/lib/utils";

const PLACES = [
  {
    name: "Your device",
    role: "What you see",
    detail: "Spaces, tabs, split view. Every page paints at full speed.",
    accent: true,
  },
  {
    name: "Your account",
    role: "What follows you",
    detail: "Workspace, settings and sign-ins, sealed before they leave.",
  },
  {
    name: "Your identity",
    role: "What sites see",
    detail: "One steady identity, so a new city doesn't look like a break-in.",
  },
  {
    name: "Your machine",
    role: "What keeps running",
    detail: "An always-on computer that finishes what you started.",
  },
];

export function Workspace() {
  return (
    <section id="workspace" className="scroll-mt-24">
      <Shell>
        <SectionHead
          index="02"
          label="The workspace"
          title={<>A daily driver first. The cloud part is invisible.</>}
          action={{ href: "#access", label: "Try it" }}
        />

        <Reveal delay={80}>
          <p className="max-w-[46ch] pb-12 text-[1.125rem] leading-[1.6] text-muted-foreground">
            Spaces, a command bar, split view, pinned tabs, and your password
            manager exactly where you expect it. Import from Chrome or Arc in
            one pass.
          </p>
        </Reveal>

        {/* The app, sitting on its own rounded ground rather than in a ruled
            plate — the frame is the picture here, not a specimen. */}
        <Reveal>
          <figure>
            <div
              data-pixel="card"
              className="rounded-2xl bg-surface p-3 sm:rounded-3xl sm:p-5"
            >
              <AppFrame />
            </div>
            <figcaption className="label mt-5 flex flex-wrap justify-between gap-4 px-1">
              <span>
                Workspace &ldquo;Work&rdquo;, restored on a second device
              </span>
              <span>Shown at 1×</span>
            </figcaption>
          </figure>
        </Reveal>

        <div className="grid gap-3 pb-20 pt-14 sm:gap-4 lg:grid-cols-4 lg:pb-28">
          {PLACES.map((place, index) => (
            <Reveal key={place.name} delay={index * 70}>
              <Card
                tone={place.accent ? "royal" : "surface"}
                className="flex h-full flex-col gap-3"
              >
                <p className={cn("label", place.accent && "!text-paper/70")}>
                  {place.role}
                </p>
                <p className="display text-[1.5rem] leading-none">
                  {place.name}
                </p>
                <p
                  className={cn(
                    "mt-auto text-[0.9375rem] leading-[1.5]",
                    place.accent ? "text-paper/80" : "text-muted-foreground",
                  )}
                >
                  {place.detail}
                </p>
              </Card>
            </Reveal>
          ))}
        </div>
      </Shell>
    </section>
  );
}
