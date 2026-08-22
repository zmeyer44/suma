import type { Metadata } from "next";

import { GalaConsole } from "@/components/gala-console";
import { requireSession } from "@/lib/auth";

export const metadata: Metadata = {
  title: "Home",
  robots: { index: false, follow: false },
};

export default async function HomePage() {
  const session = await requireSession();
  return <GalaConsole email={session.email} />;
}
