import { describe, expect, it } from "vitest";

import {
  signSession,
  verifySession,
  type GalaSession,
} from "../src/lib/session-token";

const secret = "a-test-secret-that-is-longer-than-thirty-two-characters";
const session: GalaSession = {
  email: "operator@example.com",
  expiresAt: 1_800_000,
  issuedAt: 1_000_000,
  subject: "operator-id",
};

describe("Gala session tokens", () => {
  it("round-trips a valid session", () => {
    expect(
      verifySession(signSession(session, secret), secret, 1_200_000),
    ).toEqual(session);
  });

  it("rejects a modified payload", () => {
    const token = signSession(session, secret);
    expect(verifySession(`x${token.slice(1)}`, secret, 1_200_000)).toBeNull();
  });

  it("rejects expired sessions", () => {
    expect(
      verifySession(signSession(session, secret), secret, 1_800_001),
    ).toBeNull();
  });

  it("rejects tokens signed with a different secret", () => {
    expect(
      verifySession(
        signSession(session, secret),
        `${secret}-different`,
        1_200_000,
      ),
    ).toBeNull();
  });
});
