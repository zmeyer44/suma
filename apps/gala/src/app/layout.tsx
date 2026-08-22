import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";

import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-inter",
});

const description =
  "Gala is your Suma agent away from the desktop — available from iMessage, Slack, Telegram, and wherever work finds you.";

export const metadata: Metadata = {
  title: {
    default: "Gala — your agent, already in motion",
    template: "%s · Gala",
  },
  description,
  applicationName: "Gala",
  openGraph: {
    title: "Gala — your agent, already in motion",
    description,
    type: "website",
    siteName: "Gala",
  },
  twitter: {
    card: "summary_large_image",
    title: "Gala — your agent, already in motion",
    description,
  },
};

export const viewport: Viewport = {
  colorScheme: "light",
  themeColor: "#032fdd",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      data-scroll-behavior="smooth"
      className={inter.variable}
    >
      <body>{children}</body>
    </html>
  );
}
