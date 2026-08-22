import { createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

export interface GalaSession {
  email: string;
  expiresAt: number;
  issuedAt: number;
  subject: string;
}

function encode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function signature(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function signSession(session: GalaSession, secret: string): string {
  const payload = encode(JSON.stringify(session));
  return `${payload}.${signature(payload, secret)}`;
}

export function verifySession(
  token: string,
  secret: string,
  now = Date.now(),
): GalaSession | null {
  const separator = token.lastIndexOf(".");
  if (separator < 1) return null;

  const payload = token.slice(0, separator);
  const actual = token.slice(separator + 1);
  const expected = signature(payload, secret);
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  if (
    actualBytes.length !== expectedBytes.length ||
    !timingSafeEqual(actualBytes, expectedBytes)
  ) {
    return null;
  }

  try {
    const value: unknown = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    );
    if (
      typeof value !== "object" ||
      value === null ||
      !("email" in value) ||
      !("expiresAt" in value) ||
      !("issuedAt" in value) ||
      !("subject" in value) ||
      typeof value.email !== "string" ||
      typeof value.expiresAt !== "number" ||
      typeof value.issuedAt !== "number" ||
      typeof value.subject !== "string" ||
      value.expiresAt <= now ||
      value.issuedAt > now + 60_000
    ) {
      return null;
    }
    return value as GalaSession;
  } catch {
    return null;
  }
}
