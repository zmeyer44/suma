"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { SumaMark } from "@/components/suma-mark";
import { cn } from "@/lib/utils";

const REPO_URL = "https://github.com/zmeyer44/suma";

const LINKS = [
  { href: "/#features", label: "Features" },
  { href: "/#workspace", label: "Workspace" },
  { href: "/#values", label: "Open source" },
  { href: "/download", label: "Download" },
  { href: "/#access", label: "Access" },
] as const;

function useGitHubStars() {
  const [stars, setStars] = useState<number | null>(null);
  useEffect(() => {
    fetch("https://api.github.com/repos/zmeyer44/suma")
      .then((res) => res.json())
      .then((data) => {
        if (typeof data.stargazers_count === "number") {
          setStars(data.stargazers_count);
        }
      })
      .catch(() => {});
  }, []);
  return stars;
}

function formatStars(count: number) {
  if (count >= 1000) return `${(count / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return count.toString();
}

/**
 * Two detached pills, not one bar.
 *
 * Past the fold the left pill folds its links away and keeps only the mark and
 * the menu button — the page gets its full width back, and everything the pill
 * dropped is still one click away under the ⋮.
 */
export function SiteNav() {
  const [collapsed, setCollapsed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const stars = useGitHubStars();
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onScroll = () => setCollapsed(window.scrollY > 220);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (!menuOpen) return;

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    const onClick = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };

    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onClick);
    };
  }, [menuOpen]);

  const pill =
    "flex items-center gap-1 rounded-full border bg-paper-raised/70 p-1.5 backdrop-blur-xl backdrop-saturate-150";

  return (
    <>
      <a
        href="#top"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[60] focus:bg-ink focus:px-4 focus:py-2 focus:text-sm focus:text-paper"
      >
        Skip to content
      </a>

      <header className="fixed inset-x-0 top-0 z-50 flex items-start justify-between px-3 pt-3 sm:px-5 sm:pt-5">
        <div ref={menuRef} className="relative">
          <nav className={pill}>
            <Link
              href="/"
              aria-label="Suma home"
              className="flex items-center gap-2.5 px-2.5 py-1.5 transition-opacity hover:opacity-60"
            >
              <SumaMark className="h-[24px] w-auto text-ink" />
              <span className="text-[0.9375rem] font-semibold tracking-[-0.02em]">
                Suma
              </span>
            </Link>

            <div
              className={cn(
                "hidden overflow-hidden transition-[max-width,opacity] duration-[600ms] ease-[cubic-bezier(0.16,1,0.3,1)] lg:block",
                collapsed ? "max-w-0 opacity-0" : "max-w-[34rem] opacity-100",
              )}
            >
              <ul className="flex items-center gap-0.5 whitespace-nowrap pl-1.5">
                {LINKS.slice(0, 4).map((link) => (
                  <li key={link.href}>
                    <a
                      href={link.href}
                      className="inline-flex px-3 py-2 text-[0.875rem] text-muted-foreground transition-colors hover:text-foreground"
                    >
                      {link.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>

            <button
              type="button"
              onClick={() => setMenuOpen((value) => !value)}
              aria-expanded={menuOpen}
              aria-label="Menu"
              className="flex size-9 items-center justify-center text-foreground transition-opacity hover:opacity-60"
            >
              <span className="flex flex-col gap-[3px]">
                <span className="size-[3px] rounded-full bg-current" />
                <span className="size-[3px] rounded-full bg-current" />
                <span className="size-[3px] rounded-full bg-current" />
              </span>
            </button>
          </nav>

          <div
            className={cn(
              "absolute left-0 top-[calc(100%+8px)] w-[15rem] origin-top-left rounded-3xl border bg-paper-raised/85 p-2 backdrop-blur-xl backdrop-saturate-150 transition-[opacity,transform] duration-300",
              menuOpen
                ? "pointer-events-auto scale-100 opacity-100"
                : "pointer-events-none scale-95 opacity-0",
            )}
          >
            <ul>
              {LINKS.map((link) => (
                <li key={link.href}>
                  <a
                    href={link.href}
                    onClick={() => setMenuOpen(false)}
                    className="flex items-center justify-between px-3 py-2.5 text-[0.9375rem] text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {link.label}
                    <span aria-hidden className="text-[0.75rem] opacity-40">
                      ↗
                    </span>
                  </a>
                </li>
              ))}
            </ul>
            <p className="label mt-1 border-t px-3 pb-1 pt-3">
              Private beta · Invite only
            </p>
          </div>
        </div>

        <div className={pill}>
          <a
            href={REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="hidden shrink-0 items-center gap-2 rounded-full py-1.5 pl-3 pr-3.5 text-muted-foreground transition-colors hover:text-foreground sm:flex"
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 15 15"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path
                d="M7.49933 0.25C3.49635 0.25 0.25 3.49593 0.25 7.50024C0.25 10.703 2.32715 13.4206 5.2081 14.3797C5.57084 14.446 5.70302 14.2222 5.70302 14.0299C5.70302 13.8576 5.69679 13.4019 5.69323 12.797C3.67661 13.235 3.25112 11.825 3.25112 11.825C2.92132 10.9874 2.44599 10.7644 2.44599 10.7644C1.78773 10.3149 2.49584 10.3238 2.49584 10.3238C3.22353 10.375 3.60629 11.0711 3.60629 11.0711C4.25298 12.1788 5.30335 11.8588 5.71638 11.6732C5.78225 11.205 5.96962 10.8854 6.17658 10.7043C4.56675 10.5209 2.87415 9.89918 2.87415 7.12104C2.87415 6.32925 3.15677 5.68257 3.62053 5.17563C3.54576 4.99226 3.29697 4.25521 3.69174 3.25691C3.69174 3.25691 4.30015 3.06196 5.68522 3.99973C6.26337 3.83906 6.8838 3.75895 7.50022 3.75583C8.1162 3.75895 8.73619 3.83906 9.31523 3.99973C10.6994 3.06196 11.3069 3.25691 11.3069 3.25691C11.7026 4.25521 11.4538 4.99226 11.3795 5.17563C11.8441 5.68257 12.1245 6.32925 12.1245 7.12104C12.1245 9.9063 10.4292 10.5192 8.81452 10.6985C9.07444 10.9224 9.30633 11.3648 9.30633 12.0413C9.30633 13.0102 9.29742 13.7922 9.29742 14.0299C9.29742 14.2239 9.42828 14.4496 9.79591 14.3788C12.6746 13.4179 14.75 10.7025 14.75 7.50024C14.75 3.49593 11.5036 0.25 7.49933 0.25Z"
                fill="currentColor"
                fillRule="evenodd"
                clipRule="evenodd"
              />
            </svg>
            <span className="flex flex-col whitespace-nowrap">
              <span className="text-[0.8125rem] font-medium leading-none">
                GitHub
              </span>
              <span className="text-[0.6875rem] leading-tight opacity-70">
                {formatStars(stars ?? 0)} stars
              </span>
            </span>
          </a>
          <a
            href="#access"
            className="shrink-0 whitespace-nowrap rounded-full bg-ink px-5 py-2.5 text-[0.875rem] font-medium text-paper transition-colors hover:bg-ink/85"
          >
            Get early access
          </a>
        </div>
      </header>
    </>
  );
}
