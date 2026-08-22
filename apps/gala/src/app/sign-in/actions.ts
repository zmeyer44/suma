"use server";

import { redirect } from "next/navigation";

import {
  authenticate,
  authIsConfigured,
  canonicalReturnTo,
  createSession,
} from "@/lib/auth";

export interface SignInState {
  error: string | null;
}

export async function signInAction(
  _previousState: SignInState,
  formData: FormData,
): Promise<SignInState> {
  if (!authIsConfigured()) {
    return { error: "Sign-in has not been configured for this deployment." };
  }

  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const returnTo = canonicalReturnTo(String(formData.get("returnTo") ?? ""));
  if (!email || !password) return { error: "Enter your email and password." };

  const valid = await authenticate(email, password);
  if (!valid) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    return { error: "That email and password combination wasn’t recognized." };
  }

  await createSession(email);
  redirect(returnTo);
}
