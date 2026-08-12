import { Analytics } from "@vercel/analytics/next";
import type { Metadata, Viewport } from "next";
import { Host_Grotesk, IBM_Plex_Mono } from "next/font/google";
import localFont from "next/font/local";

import { PixelField } from "@/components/pixel-field";
import { SiteFooter } from "@/components/site-footer";
import { SiteNav } from "@/components/site-nav";
import { cn } from "@/lib/utils";

import "./globals.css";

const hostGrotesk = Host_Grotesk({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-host-grotesk",
});

/**
 * Industry, the display face — headlines only; body copy stays on Host Grotesk.
 * There is no variable cut, so each weight is its own file, self-hosted from
 * `src/fonts` rather than fetched. It ships nothing under 600, which is why
 * `.display` in `globals.css` sets its own weight.
 */
const industry = localFont({
  src: [
    {
      path: "../fonts/Industry-SemiBold.woff2",
      weight: "600",
      style: "normal",
    },
    { path: "../fonts/Industry-Bold.woff2", weight: "700", style: "normal" },
    {
      path: "../fonts/Industry-ExtraBold.woff2",
      weight: "800",
      style: "normal",
    },
    { path: "../fonts/Industry-Black.woff2", weight: "900", style: "normal" },
  ],
  display: "swap",
  variable: "--font-industry",
});

const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  display: "swap",
  weight: ["400", "500"],
  variable: "--font-plex-mono",
});

const title = "Suma — the browser that remembers where you left off";
const description =
  "Suma is an open-source browser with cloud-native memory. Sign in once and your spaces, tabs, sign-ins and files follow you to any machine — with smart saves, offline video, read-aloud, a built-in Nostr signer, and an always-on cloud computer with its own terminal and IDE.";

export const metadata: Metadata = {
  metadataBase: new URL("https://sumabrowser.com"),
  title: {
    default: title,
    template: "%s — Suma",
  },
  description,
  applicationName: "Suma",
  keywords: [
    "browser",
    "open source browser",
    "workspace continuity",
    "portable workspace",
    "cloud browser",
    "work from anywhere",
    "nostr browser",
    "offline video",
    "read aloud",
    "cloud terminal",
  ],
  openGraph: {
    title,
    description,
    type: "website",
    siteName: "Suma",
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
  },
  icons: {
    icon: "/mark.svg",
  },
};

export const viewport: Viewport = {
  themeColor: "#f3f2ec",
  colorScheme: "light",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={cn(hostGrotesk.variable, plexMono.variable, industry.variable)}
    >
      <body className="graph relative min-h-dvh overflow-x-hidden font-sans">
        <PixelField />
        <SiteNav />
        {/* The pixel field is fixed at z-0; content must sit above it. */}
        <main id="top" className="relative z-10">
          {children}
        </main>
        <SiteFooter />
        <Analytics />
      </body>
    </html>
  );
}
