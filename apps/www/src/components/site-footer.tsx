import { SumaMark } from "@/components/suma-mark";
import { Shell } from "@/components/section";

const LINKS = [
  { label: "Workspace", href: "#workspace" },
  { label: "Features", href: "#features" },
  { label: "Open source", href: "#values" },
  { label: "Access", href: "#access" },
  { label: "GitHub", href: "https://github.com/zmeyer44/suma" },
  { label: "Contact", href: "mailto:invites@sumabrowser.com" },
];

/** The specification, compressed to a footer strip rather than its own band. */
const SPECS = [
  "macOS 14+ · Apple Silicon",
  "Open source · AGPL-3.0",
  "Passkey sign-in · every device you approve",
  "Encrypted per space · offline recovery code",
  "Sensitive sites stay out of sync until you say so",
];

export function SiteFooter() {
  return (
    <footer className="relative z-10">
      <Shell>
        <div className="grid gap-x-16 gap-y-10 border-t border-border py-14 sm:grid-cols-12">
          <div className="sm:col-span-5">
            <span className="flex items-center gap-2.5">
              <SumaMark className="h-[26px] w-auto text-royal" />
              <span className="text-[0.9375rem] font-semibold tracking-[-0.02em]">
                Suma
              </span>
            </span>
            <p className="mt-6 max-w-[32ch] text-[1.0625rem] leading-[1.55] text-muted-foreground">
              Your browser, your files and your work — wherever you sit down.
            </p>
            <ul className="mt-8 flex flex-wrap gap-x-6 gap-y-2">
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

          <ul className="flex flex-wrap content-start gap-2 sm:col-span-6 sm:col-start-7">
            {SPECS.map((spec) => (
              <li
                key={spec}
                className="label rounded-full bg-surface px-4 py-2.5"
              >
                {spec}
              </li>
            ))}
          </ul>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-4 border-t border-border py-5">
          <p className="label">
            © {new Date().getFullYear()} Suma — private beta
          </p>
          <p className="label">[ZACH|MEYER]</p>
        </div>
      </Shell>
    </footer>
  );
}
