import { SumaMark } from "@/components/suma-mark";
import { Shell } from "@/components/section";

const LINKS = [
  { label: "Features", href: "#features" },
  { label: "Workspace", href: "#workspace" },
  { label: "Open source", href: "#values" },
  { label: "Access", href: "#access" },
  { label: "GitHub", href: "https://github.com/zmeyer44/suma" },
  { label: "Contact", href: "mailto:invites@sumabrowser.com" },
];

/** The specification, kept to a quiet ruled list rather than its own band. */
const SPECS = [
  "macOS 14+ · Apple Silicon",
  "Open source · AGPL-3.0",
  "Passkey sign-in · every device you approve",
  "Encrypted per space · offline recovery code",
  "Sensitive sites stay out of sync until you say so",
];

export function SiteFooter() {
  return (
    <footer className="relative pt-24 sm:pt-32">
      <Shell>
        <div className="grid gap-x-16 gap-y-12 border-t py-14 sm:grid-cols-12 sm:py-20">
          <div className="sm:col-span-6">
            <span className="flex items-center gap-2.5">
              <SumaMark className="h-[24px] w-auto text-ink" />
              <span className="text-[0.9375rem] font-semibold tracking-[-0.02em]">
                Suma
              </span>
            </span>
            <p className="display mt-8 max-w-[16ch] text-[clamp(1.75rem,3vw,2.5rem)] leading-[1.1]">
              Your work, wherever you sit down.
            </p>
            <ul className="mt-10 flex flex-wrap gap-x-7 gap-y-2">
              {LINKS.map((link) => (
                <li key={link.label}>
                  <a
                    href={link.href}
                    className="text-[0.9375rem] text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {link.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>

          <div className="sm:col-span-5 sm:col-start-8">
            <p className="label pb-4">The fine print</p>
            <ul>
              {SPECS.map((spec) => (
                <li
                  key={spec}
                  className="border-t py-3.5 text-[0.875rem] leading-[1.5] text-muted-foreground last:border-b"
                >
                  {spec}
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-4 border-t py-6">
          <p className="label">© {new Date().getFullYear()} Suma — private beta</p>
          <p className="label">[ZACH|MEYER]</p>
        </div>
      </Shell>
    </footer>
  );
}
