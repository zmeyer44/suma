import { Reveal } from "@/components/reveal";
import { SectionHead, Shell } from "@/components/section";

/**
 * The four grounds a workspace stands on, set as a Swiss column grid: a top
 * rule each, the role as a label, the name in the display face. No cards —
 * the rules and the whitespace do the separating.
 */
const PLACES = [
  {
    name: "Your device",
    role: "What you see",
    detail: "Spaces, tabs, split view. Every page paints at full speed.",
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
    <section id="workspace" className="scroll-mt-24 pt-24 sm:pt-32">
      <Shell>
        <SectionHead
          index="02"
          label="The workspace"
          title={<>A daily driver first. The cloud part is invisible.</>}
          action={{ href: "#access", label: "Try it" }}
        />

        <Reveal delay={80}>
          <p className="max-w-[46ch] pt-6 text-[1.0625rem] leading-[1.6] text-muted-foreground">
            Spaces, a command bar, split view, pinned tabs, and your password
            manager exactly where you expect it. Import from Chrome or Arc in
            one pass.
          </p>
        </Reveal>

        <div className="grid gap-x-10 gap-y-12 pt-14 sm:grid-cols-2 sm:pt-20 lg:grid-cols-4">
          {PLACES.map((place, index) => (
            <Reveal key={place.name} delay={index * 80}>
              <div className="border-t pt-5">
                <p className="label">{place.role}</p>
                <p className="display mt-10 text-[1.75rem] leading-none sm:mt-14">
                  {place.name}
                </p>
                <p className="mt-4 max-w-[28ch] text-[0.9375rem] leading-[1.55] text-muted-foreground">
                  {place.detail}
                </p>
              </div>
            </Reveal>
          ))}
        </div>
      </Shell>
    </section>
  );
}
