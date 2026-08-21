import { describe, expect, it } from "vitest";
import {
  cleanOutput,
  extractJobOutput,
  JOBS_DIR,
  joinShellPath,
  planJob,
  resolveSendKeys,
  sentinelIn,
  shellPathExpr,
  shellQuote,
  stripAnsi,
} from "../src/main/shell/assistant-shell-core";

const JOB_ID = "1755777600000-ab12cd34";
const NONCE = "ab12cd34";

describe("shell quoting", () => {
  it("single-quotes anything, including quotes and dollars", () => {
    expect(shellQuote("plain")).toBe("'plain'");
    expect(shellQuote("it's $HOME `x` \"y\"")).toBe(
      "'it'\\''s $HOME `x` \"y\"'",
    );
  });

  it("keeps ~ expandable while quoting the rest", () => {
    expect(shellPathExpr("~")).toBe('"$HOME"');
    expect(shellPathExpr("~/cloud/My Space")).toBe("\"$HOME\"'/cloud/My Space'");
    expect(shellPathExpr("/Users/x/Suma")).toBe("'/Users/x/Suma'");
  });

  it("joins shell paths without doubling slashes", () => {
    expect(joinShellPath("~/cloud", "/.suma/jobs/a.sh")).toBe(
      "~/cloud/.suma/jobs/a.sh",
    );
    expect(joinShellPath("/root/", "x")).toBe("/root/x");
    expect(joinShellPath("/root", "")).toBe("/root");
  });
});

describe("planJob", () => {
  const plan = planJob(
    "echo 'hi there'\ncat <<EOF\nline\twith tab\nEOF\n",
    "~/cloud/Personal--abc",
    "~/cloud",
    JOB_ID,
    NONCE,
  );

  it("keeps the command byte-exact in its own script", () => {
    expect(plan.cmdScript).toBe("echo 'hi there'\ncat <<EOF\nline\twith tab\nEOF\n");
    expect(plan.cmdVfsPath).toBe(`${JOBS_DIR}/${JOB_ID}.cmd.sh`);
  });

  it("types one short line with no sentinel material and no command text", () => {
    expect(plan.typedLine.startsWith("\x15bash ")).toBe(true);
    expect(plan.typedLine.endsWith("\r")).toBe(true);
    expect(plan.typedLine).toContain(`${JOB_ID}.ctl.sh`);
    expect(plan.typedLine).not.toContain("echo");
    expect(plan.typedLine).not.toContain("\n");
  });

  it("never contains the assembled sentinel anywhere it could echo", () => {
    const assembled = new RegExp(`<<SUMA-${NONCE}:`, "u");
    expect(assembled.test(plan.typedLine)).toBe(false);
    expect(assembled.test(plan.ctlScript)).toBe(false);
    expect(assembled.test(plan.cmdScript)).toBe(false);
    // …but the pieces are there to produce it at runtime.
    expect(plan.ctlScript).toContain("<<%s:%d>>");
    expect(plan.ctlScript).toContain(`'SUMA-${NONCE}'`);
  });

  it("runs the command in a child bash and reports cd failure as 97", () => {
    expect(plan.ctlScript).toContain('cd "$HOME"\'/cloud/Personal--abc\' ||');
    expect(plan.ctlScript).toContain("97");
    expect(plan.ctlScript).toContain('exit "$__suma_rc"');
    expect(plan.ctlScript).toContain("export NO_COLOR=1");
  });

  it("rejects malformed identities", () => {
    expect(() => planJob("x", "/a", "/b", "bad job", NONCE)).toThrow(/identity/);
    expect(() => planJob("x", "/a", "/b", JOB_ID, "XYZ")).toThrow(/identity/);
  });
});

describe("sentinelIn", () => {
  it("finds the exit code, preferring the last match", () => {
    expect(sentinelIn(`out\n<<SUMA-${NONCE}:0>>\n`, NONCE)).toEqual({ exitCode: 0 });
    expect(
      sentinelIn(`<<SUMA-${NONCE}:1>>\nmore\n<<SUMA-${NONCE}:3>>`, NONCE),
    ).toEqual({ exitCode: 3 });
    expect(sentinelIn(`<<SUMA-${NONCE}:-15>>`, NONCE)).toEqual({ exitCode: -15 });
  });

  it("ignores other nonces and partial matches", () => {
    expect(sentinelIn("<<SUMA-deadbeef:0>>", NONCE)).toBeNull();
    expect(sentinelIn(`<<SUMA-${NONCE}:>>`, NONCE)).toBeNull();
    expect(sentinelIn(`<<SUMA-${NONCE}:0`, NONCE)).toBeNull();
  });
});

describe("extractJobOutput", () => {
  it("returns only the text between the typed-line echo and the sentinel", () => {
    const text = [
      "user@host ~ % previous noise",
      `user@host ~ % bash "$HOME"'/cloud/.suma/jobs/${JOB_ID}.ctl.sh'`,
      "hello from the command",
      "line two",
      `<<SUMA-${NONCE}:0>>`,
      "user@host ~ % ",
    ].join("\n");
    expect(extractJobOutput(text, JOB_ID, NONCE)).toBe(
      "hello from the command\nline two",
    );
  });

  it("falls back to everything before the sentinel when the echo is mangled", () => {
    const text = `garbled echo\noutput line\n<<SUMA-${NONCE}:2>>\n`;
    expect(extractJobOutput(text, JOB_ID, NONCE)).toBe(
      "garbled echo\noutput line",
    );
  });
});

describe("cleanOutput", () => {
  it("passes small output through untouched", () => {
    expect(cleanOutput("short", 100)).toEqual({ text: "short", truncated: false });
  });

  it("elides the middle, keeping a larger tail, within budget", () => {
    const line = "x".repeat(99) + "\n";
    const big = line.repeat(1000);
    const { text, truncated } = cleanOutput(big, 4000);
    expect(truncated).toBe(true);
    expect(text).toContain("bytes of output omitted");
    expect(text.length).toBeLessThan(4200);
    const marker = text.indexOf("…[");
    expect(marker).toBeGreaterThan(0);
    expect(text.length - marker).toBeGreaterThan(marker); // tail > head
  });

  it("never splits a multi-byte character", () => {
    const big = "é".repeat(10_000);
    const { text } = cleanOutput(big, 1000);
    expect(text.includes("�")).toBe(false);
  });
});

describe("stripAnsi", () => {
  it("removes CSI, OSC, and control noise", () => {
    const raw =
      "\x1b]0;title\x07\x1b[31mred\x1b[0m plain\r\nnext\x1b[2Kline\rover";
    const clean = stripAnsi(raw);
    expect(clean).toContain("red plain");
    expect(clean).not.toContain("\x1b");
    expect(clean).not.toContain("title");
  });
});

describe("resolveSendKeys", () => {
  it("maps named keys to their byte sequences", () => {
    expect(resolveSendKeys(["Enter"])).toBe("\r");
    expect(resolveSendKeys(["Up", "Down", "C-c"])).toBe("\x1b[A\x1b[B\x03");
    expect(resolveSendKeys([])).toBe("");
  });

  it("names the unknown key in the error", () => {
    expect(() => resolveSendKeys(["Enter", "Meta-x"])).toThrow(/Meta-x/);
  });
});
