import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SimAgent } from "../src/main/compute/sim-agent";
import { TerminalService } from "../src/main/compute/terminal-service";
import { AssistantShellService } from "../src/main/shell/assistant-shell-service";
import type { PortsService } from "../src/main/compute/ports-service";

/**
 * Runs against a real SimAgent on a temp root. Under vitest workers node-pty
 * is unavailable, so shells take the cooked pipe fallback (sim-agent.ts) — the
 * job protocol is designed to work there too: the typed line carries no
 * sentinel material and `bash <ctl>` output flows through normally.
 */

let root: string;
let link: SimAgent;
let terminals: TerminalService;
let shell: AssistantShellService;

const stubPorts = {
  refresh: async () => [],
} as unknown as PortsService;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "suma-shell-"));
  link = new SimAgent({ root: () => root });
  terminals = new TerminalService({
    link,
    control: () => null,
    emitData: () => undefined,
    emitUpdated: () => undefined,
    defaultCwd: async () => root,
  });
  shell = new AssistantShellService();
  shell.bind({
    terminals,
    link,
    ports: stubPorts,
    shellWorkspaceRoot: () => root,
    defaultCwd: async () => root,
  });
});

afterEach(async () => {
  shell.stopAll();
  link.stop();
  await rm(root, { recursive: true, force: true });
});

describe("AssistantShellService.run", () => {
  it("runs a command and returns its output with exit code 0", async () => {
    const result = await shell.run({ command: "echo hello-suma" });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("hello-suma");
    expect(result.timedOut).toBeUndefined();
  }, 30_000);

  it("reports a non-zero exit code", async () => {
    const result = await shell.run({ command: "exit 3" });
    expect(result.exitCode).toBe(3);
  }, 30_000);

  it("runs a multiline command with a heredoc, writing a real file", async () => {
    const result = await shell.run({
      command:
        "mkdir -p sub\ncat > sub/note.txt <<EOF\nline one\nline two\nEOF\necho wrote",
    });
    expect(result.exitCode).toBe(0);
    const written = await readFile(path.join(root, "sub", "note.txt"), "utf8");
    expect(written).toBe("line one\nline two\n");
  }, 30_000);

  it("honors cwd relative to the workspace root", async () => {
    await shell.run({ command: "mkdir -p project" });
    const result = await shell.run({ command: "pwd", cwd: "project" });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain(path.join(root, "project"));
  }, 30_000);

  it("times out a slow command, then wait_for_output finishes it", async () => {
    const timed = await shell.run({
      command: "sleep 2 && echo late-done",
      timeoutSeconds: 1,
    });
    expect(timed.timedOut).toBe(true);
    expect(timed.exitCode).toBeNull();
    const finished = await shell.waitForOutput(timed.shellId, {
      timeoutSeconds: 5,
    });
    expect("running" in finished).toBe(false);
    if ("running" in finished) throw new Error("job did not finish");
    expect(finished.exitCode).toBe(0);
    expect(finished.output).toContain("late-done");
    // A timed-out shell keeps a stable shellId for future reads; a new job
    // gets a different fungible task shell instead of overwriting its state.
    const reused = await shell.run({ command: "echo reused" });
    expect(reused.shellId).not.toBe(timed.shellId);
    expect(reused.output).toContain("reused");
  }, 40_000);

  it("reserves different PTYs for parallel foreground commands", async () => {
    await shell.run({ command: "echo warm" });
    const [one, two] = await Promise.all([
      shell.run({ command: "sleep 1; echo one" }),
      shell.run({ command: "echo two" }),
    ]);
    expect(one.shellId).not.toBe(two.shellId);
    expect(one.output).toContain("one");
    expect(two.output).toContain("two");
  }, 30_000);

  it("removes desktop environment secrets from assistant commands", async () => {
    const key = "SUMA_ASSISTANT_TEST_SECRET";
    const previous = process.env[key];
    process.env[key] = "must-not-reach-the-model";
    try {
      const result = await shell.run({ command: `printf '%s' "$${key}"` });
      expect(result.output).not.toContain("must-not-reach-the-model");
    } finally {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  }, 30_000);

  it("interrupts a foreground command when its turn is aborted", async () => {
    const controller = new AbortController();
    const running = shell.run(
      { command: "sleep 20; echo should-not-finish" },
      controller.signal,
    );
    setTimeout(() => controller.abort(new Error("turn stopped")), 300);
    await expect(running).rejects.toThrow(/turn stopped/);
  }, 30_000);

  it("rejects a cwd that escapes the workspace", async () => {
    await expect(
      shell.run({ command: "pwd", cwd: "../../etc" }),
    ).rejects.toThrow(/inside your workspace/);
  }, 30_000);

  it("runs foreground commands on a bounded pool of reused shells", async () => {
    await shell.run({ command: "echo a" });
    await shell.run({ command: "echo b" });
    const taskShells = shell.listShells().filter((s) => s.purpose === "task");
    expect(taskShells.length).toBe(1); // reused, not spawned per command
  }, 30_000);
});

describe("AssistantShellService background + interactive", () => {
  it("keeps an explicit background job running after its turn is stopped", async () => {
    const controller = new AbortController();
    const running = shell.run(
      {
        command: "sleep 1; echo survived-stopped-turn",
        background: true,
      },
      controller.signal,
    );
    setTimeout(() => controller.abort(new Error("turn stopped")), 100);
    const finished = await running;
    expect(finished.exitCode).toBe(0);
    expect(finished.output).toContain("survived-stopped-turn");
  }, 30_000);

  it("recognizes normal completion of a short background command", async () => {
    const bg = await shell.run({
      command: "sleep 2; echo background-done",
      background: true,
    });
    expect(bg.exitCode).toBeNull();
    const finished = await shell.waitForOutput(bg.shellId, {
      timeoutSeconds: 5,
    });
    expect("running" in finished).toBe(false);
    if ("running" in finished) throw new Error("job did not finish");
    expect(finished.exitCode).toBe(0);
    expect(finished.output).toContain("background-done");
  }, 30_000);

  it("starts a background process and reads its output, then kills it", async () => {
    const bg = await shell.run({
      command: "for i in 1 2 3 4 5; do echo tick-$i; sleep 1; done",
      background: true,
    });
    expect(bg.exitCode).toBeNull();
    const before = shell.listShells().length;
    expect(before).toBeGreaterThan(0);
    const read = shell.readTerminal(bg.shellId, "tail", 50);
    expect(read.running).toBe(true);
    await shell.killShell(bg.shellId);
    expect(
      shell.listShells().find((s) => s.shellId === bg.shellId),
    ).toBeUndefined();
  }, 30_000);

  it("opens an interactive shell and drives it with send_keys", async () => {
    const opened = await shell.openInteractive();
    expect(opened.shellId).toBeTruthy();
    await shell.sendKeys(opened.shellId, "echo from-keys", ["Enter"]);
    const read = shell.readTerminal(opened.shellId, "tail", 50);
    expect(read.text).toContain("from-keys");
  }, 30_000);

  it("marks an assistant shell exited when the user closes its terminal", async () => {
    const opened = await shell.openInteractive();
    await terminals.close(opened.shellId);
    expect(shell.listShells()).toContainEqual(
      expect.objectContaining({ shellId: opened.shellId, exited: true }),
    );
    expect(shell.readTerminal(opened.shellId).running).toBe(false);
  }, 30_000);
});

describe("AssistantShellService availability", () => {
  it("is unavailable and throws helpfully with no link bound", async () => {
    const unbound = new AssistantShellService();
    expect(unbound.available()).toBe(false);
    await expect(unbound.run({ command: "echo x" })).rejects.toThrow(
      /no computer is connected/,
    );
  });
});
