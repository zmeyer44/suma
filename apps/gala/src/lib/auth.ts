import "server-only";

import { createHash, scrypt as nodeScrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import {
  SESSION_TTL_SECONDS,
  signSession,
  verifySession,
  type GalaSession,
} from "@/lib/session-token";

const scrypt = promisify(nodeScrypt);
const COOKIE_NAME = "gala_session";
const MIN_SECRET_LENGTH = 32;

function authSecret(): string | null {
  const secret = process.env.GALA_AUTH_SECRET?.trim();
  return secret !== undefined && secret.length >= MIN_SECRET_LENGTH
    ? secret
    : null;
}

function canonicalReturnTo(value: string | null): string {
  return value?.startsWith("/") && !value.startsWith("//") ? value : "/home";
}

export function authIsConfigured(): boolean {
  return Boolean(
    authSecret() &&
    process.env.GALA_ADMIN_EMAIL?.trim() &&
    process.env.GALA_ADMIN_PASSWORD_HASH?.trim(),
  );
}

export async function authenticate(
  email: string,
  password: string,
): Promise<boolean> {
  const expectedEmail = process.env.GALA_ADMIN_EMAIL?.trim().toLowerCase();
  const encodedHash = process.env.GALA_ADMIN_PASSWORD_HASH?.trim();
  if (
    !authSecret() ||
    !expectedEmail ||
    !encodedHash ||
    password.length > 512
  ) {
    return false;
  }

  const [salt, expected] = encodedHash.split(":", 2);
  if (!salt || !expected) return false;

  try {
    const actualBytes = (await scrypt(password, salt, 64)) as Buffer;
    const expectedBytes = Buffer.from(expected, "base64url");
    const passwordMatches =
      actualBytes.length === expectedBytes.length &&
      timingSafeEqual(actualBytes, expectedBytes);
    return email.trim().toLowerCase() === expectedEmail && passwordMatches;
  } catch {
    return false;
  }
}

export async function createSession(email: string): Promise<void> {
  const secret = authSecret();
  if (!secret) throw new Error("Gala authentication is not configured");

  const issuedAt = Date.now();
  const session: GalaSession = {
    email: email.trim().toLowerCase(),
    expiresAt: issuedAt + SESSION_TTL_SECONDS * 1_000,
    issuedAt,
    subject: createHash("sha256")
      .update(email.trim().toLowerCase())
      .digest("base64url"),
  };
  (await cookies()).set(COOKIE_NAME, signSession(session, secret), {
    httpOnly: true,
    maxAge: SESSION_TTL_SECONDS,
    path: "/",
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });
}

export async function getSession(): Promise<GalaSession | null> {
  const secret = authSecret();
  const token = (await cookies()).get(COOKIE_NAME)?.value;
  if (!secret || !token) return null;
  return verifySession(token, secret);
}

export async function requireSession(): Promise<GalaSession> {
  const session = await getSession();
  if (!session) redirect("/sign-in?returnTo=/home");
  return session;
}

export async function destroySession(): Promise<void> {
  (await cookies()).delete(COOKIE_NAME);
}

export { canonicalReturnTo };
