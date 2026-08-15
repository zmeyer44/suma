import { Analytics } from "@vercel/analytics/next";
import type { Metadata, Viewport } from "next";
import { Host_Grotesk, IBM_Plex_Mono } from "next/font/google";
import localFont from "next/font/local";

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
 * Vanguardia (Latinotype), the display face — headlines only; body copy
 * stays on Host Grotesk. One static regular cut, roman only: there is no
 * italic and no other weight, which is why nothing on the site italicises
 * or bolds display type. Web-licensed, so the file does not belong in a
 * public repo.
 */
const vanguardia = localFont({
  src: "../fonts/vanguardia-regular.woff2",
  display: "swap",
  weight: "400",
  variable: "--font-vanguardia",
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
  themeColor: "#ffffff",
  colorScheme: "light",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={cn(
        hostGrotesk.variable,
        plexMono.variable,
        vanguardia.variable,
      )}
    >
      <body className="relative min-h-dvh overflow-x-hidden font-sans">
        <SiteNav />
        <main id="top" className="relative">
          {children}
        </main>
        <SiteFooter />
        <Analytics />
      </body>
    </html>
  );
}
