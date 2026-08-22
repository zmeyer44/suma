"use server";

import { redirect } from "next/navigation";

import { destroySession, requireSession } from "@/lib/auth";

export async function signOutAction(): Promise<never> {
  await requireSession();
  await destroySession();
  redirect("/sign-in");
}
