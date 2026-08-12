import { describe, expect, it } from "vitest";
import {
  CAPABILITIES,
  CTL_CAPABILITY,
  TERMINAL_CAPABILITIES,
  accruedCostUsd,
  checkCapability,
  decideSuspend,
  explainVerdict,
  formatHourlyRate,
  hourlyRateUsd,
  parseChannel,
  parseCtlRequest,
  type CapabilityClaims,
  type LifecycleInputs,
  type ProcessTreeInfo,
} from "../src/index.js";

const claims = (over: Partial<CapabilityClaims> = {}): CapabilityClaims => ({
  mid: "machine-1",
  sub: "user-1",
  caps: [...TERMINAL_CAPABILITIES],
  iat: 1000,
  exp: 2000,
  jti: "tok-1",
  ...over,
});

describe("capability tokens (I-2: VM compromise is worthless beyond the VM)", () => {
  it("names no capability for device enrollment, session records, keys, or egress", () => {
    const forbidden = ["device", "enroll", "session", "cookie", "key", "egress", "gateway"];
    for (const cap of CAPABILITIES) {
      for (const word of forbidden) {
        expect(cap.includes(word), `${cap} must not grant ${word}`).toBe(false);
      }
    }
  });

  it("refuses a token bound to a different machine", () => {
    expect(checkCapability(claims(), "machine-2", "pty.spawn", 1500)).toBe(
      "token is bound to a different machine",
    );
  });

  it("refuses an expired token", () => {
    expect(checkCapability(claims(), "machine-1", "pty.spawn", 2001)).toBe(
      "capability token expired",
    );
  });

  it("refuses a capability that was not granted", () => {
    expect(checkCapability(claims(), "machine-1", "fs.write", 1500)).toBe(
      "capability fs.write not granted",
    );
    // A terminal session cannot fetch or write the filesystem by default.
    expect(TERMINAL_CAPABILITIES).not.toContain("fs.write");
    expect(TERMINAL_CAPABILITIES).not.toContain("fetch.public");
  });

  it("allows a granted, unexpired, machine-matched capability", () => {
    expect(checkCapability(claims(), "machine-1", "pty.spawn", 1500)).toBeNull();
  });

  it("maps every ctl operation to a capability", () => {
    for (const [op, cap] of Object.entries(CTL_CAPABILITY)) {
      expect(CAPABILITIES, `${op} maps to an unknown capability`).toContain(cap);
    }
  });
});

describe("mux channels (Appendix C)", () => {
  it("parses the documented channel names", () => {
    expect(parseChannel("ctl")).toEqual({ kind: "ctl" });
    expect(parseChannel("vfs")).toEqual({ kind: "vfs" });
    expect(parseChannel("log")).toEqual({ kind: "log" });
    expect(parseChannel("pty/abc123")).toEqual({ kind: "pty", id: "abc123" });
    expect(parseChannel("fwd/3000")).toEqual({ kind: "fwd", port: 3000 });
  });

  it("rejects malformed or out-of-range channels", () => {
    for (const bad of ["", "nope", "pty/", "pty", "fwd/0", "fwd/70000", "fwd/abc", "fwd"]) {
      expect(parseChannel(bad), bad).toBeNull();
    }
  });

  it("validates ctl requests", () => {
    const spawn = parseCtlRequest(
      JSON.stringify({ t: "pty.spawn", ptyId: "p1", cols: 80, rows: 24 }),
    );
    expect(spawn.t).toBe("pty.spawn");
    expect(() => parseCtlRequest(JSON.stringify({ t: "pty.spawn", ptyId: "p1" }))).toThrow();
    expect(() => parseCtlRequest(JSON.stringify({ t: "nope" }))).toThrow();
    // Only public/presigned URLs — the shape refuses anything that isn't a URL.
    expect(() =>
      parseCtlRequest(JSON.stringify({ t: "fetch.public", url: "not a url", destPath: "/x" })),
    ).toThrow();
  });

  it("refuses a fetch URL carrying CR/LF, which would smuggle headers", () => {
    // WHATWG url parsing tolerates raw control characters and returns the
    // string unmodified, so `z.string().url()` alone would let this through
    // and a client that formats a request line by interpolation would emit an
    // attacker-chosen header — or a second request entirely.
    const smuggle = "http://host/x HTTP/1.1\r\nCookie: stolen\r\n\r\nGET /admin";
    expect(() =>
      parseCtlRequest(JSON.stringify({ t: "fetch.public", url: smuggle, destPath: "/x" })),
    ).toThrow();
    // Percent-encoded CRLF is not an injection and stays allowed.
    const encoded = "https://example.com/a%0d%0ab";
    expect(
      parseCtlRequest(JSON.stringify({ t: "fetch.public", url: encoded, destPath: "/x" })).t,
    ).toBe("fetch.public");
  });
});

describe("process-aware lifecycle (§8.5 — silence is not idleness)", () => {
  const shell: ProcessTreeInfo = {
    ptyId: "p1",
    command: "-zsh",
    shellOnly: true,
    suspendOptIn: false,
    jobMode: false,
  };
  const build: ProcessTreeInfo = {
    ptyId: "p2",
    command: "npm run build",
    shellOnly: false,
    suspendOptIn: false,
    jobMode: false,
  };
  const inputs = (over: Partial<LifecycleInputs> = {}): LifecycleInputs => ({
    clientsAttached: 0,
    processes: [shell],
    idleMs: 10 * 60 * 1000,
    activeTransfers: 0,
    idleSuspendAfterMs: 5 * 60 * 1000,
    ...over,
  });

  it("suspends an idle shell-only machine", () => {
    expect(decideSuspend(inputs())).toEqual({ suspend: true, reason: "idle_shell" });
  });

  it("NEVER suspends while a non-shell process tree is alive, however quiet", () => {
    // The v1.0 bug: a silent build looked idle and got suspended, freezing
    // wall-clock progress.
    const v = decideSuspend(inputs({ processes: [shell, build] }));
    expect(v.suspend).toBe(false);
    expect(v.suspend === false && v.reason).toBe("user_process_alive");
    expect(v.suspend === false && v.ptyId).toBe("p2");
  });

  it("suspends a workload the user explicitly opted in", () => {
    const optedIn = { ...build, suspendOptIn: true };
    expect(decideSuspend(inputs({ processes: [shell, optedIn] })).suspend).toBe(true);
  });

  it("keeps the machine awake in Job Mode even with only a shell", () => {
    const job = { ...shell, jobMode: true };
    const v = decideSuspend(inputs({ processes: [job] }));
    expect(v.suspend).toBe(false);
    expect(v.suspend === false && v.reason).toBe("job_mode");
  });

  it("stays awake for attached clients, transfers, and inside the idle grace", () => {
    expect(decideSuspend(inputs({ clientsAttached: 1 })).suspend).toBe(false);
    expect(decideSuspend(inputs({ activeTransfers: 1 })).suspend).toBe(false);
    expect(decideSuspend(inputs({ idleMs: 60_000 })).suspend).toBe(false);
  });

  it("explains every verdict for the status pill", () => {
    expect(explainVerdict(decideSuspend(inputs()))).toContain("suspending");
    expect(explainVerdict(decideSuspend(inputs({ processes: [shell, build] })))).toContain(
      "still running",
    );
  });
});

describe("cost meter (§8.5 visible cost, §11)", () => {
  it("quotes a plausible hourly rate for the default 2 GB machine", () => {
    const rate = hourlyRateUsd(2048, 2);
    expect(rate).toBeGreaterThan(0);
    expect(rate).toBeLessThan(0.2);
    expect(formatHourlyRate(2048, 2)).toMatch(/^~\$\d+\.\d{2}\/hr while awake$/);
  });

  it("accrues cost proportionally to awake time", () => {
    const hour = accruedCostUsd(2048, 2, 3_600_000);
    const half = accruedCostUsd(2048, 2, 1_800_000);
    expect(hour).toBeCloseTo(hourlyRateUsd(2048, 2), 4);
    expect(half).toBeCloseTo(hour / 2, 4);
    expect(accruedCostUsd(2048, 2, 0)).toBe(0);
  });

  it("charges more for a boosted machine", () => {
    expect(hourlyRateUsd(8192, 4)).toBeGreaterThan(hourlyRateUsd(2048, 2));
  });
});
