import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createComputerToolSet } from "@suma/assistant-core/computer";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SimAgent } from "../../../apps/desktop/src/main/compute/sim-agent";
import { RemoteComputerBackend } from "../src/computer";

describe("remote computer backend", () => {
  let sim: SimAgent;
  let computer: RemoteComputerBackend;

  beforeEach(async () => {
    const root = await mkdtemp(join(tmpdir(), "suma-remote-computer-"));
    sim = new SimAgent({ root: () => root });
    computer = new RemoteComputerBackend({ link: sim });
  });

  afterEach(() => sim.stop());

  it("runs commands and drives an interactive shell through the agent mux", async () => {
    const completed = await computer.runCommand({
      command: "printf 'hello from the vm'",
      timeoutSeconds: 10,
    });

    expect(completed.output).toContain("hello from the vm");
    expect(completed.exitCode).toBe(0);
    expect(completed.timedOut).toBeUndefined();

    const running = await computer.runCommand({
      command: "printf 'ready\\n'; read answer; printf 'received:%s\\n' \"$answer\"",
      background: true,
    });
    const ready = await computer.waitForOutput({
      shellId: running.shellId,
      pattern: "ready",
      timeoutSeconds: 10,
    });
    expect(ready.output).toContain("ready");

    await computer.sendKeys(running.shellId, "remote input\n");
    const finished = await computer.waitForOutput({
      shellId: running.shellId,
      timeoutSeconds: 10,
    });
    expect(finished.output).toContain("received:remote input");
    expect(finished.exitCode).toBe(0);
  });

  it("reattaches to a shell created by an earlier runner instance", async () => {
    const running = await computer.runCommand({
      command: "printf 'waiting\\n'; read answer; printf 'continued:%s\\n' \"$answer\"",
      background: true,
    });
    await computer.waitForOutput({
      shellId: running.shellId,
      pattern: "waiting",
      timeoutSeconds: 10,
    });

    const afterRestart = new RemoteComputerBackend({ link: sim });
    expect((await afterRestart.readTerminal(running.shellId)).output).toContain(
      "waiting",
    );
    await afterRestart.sendKeys(running.shellId, "still here\n");
    const finished = await afterRestart.waitForOutput({
      shellId: running.shellId,
      pattern: "continued:still here",
      timeoutSeconds: 10,
    });
    expect(finished.output).toContain("continued:still here");
  });

  it("reads, writes, lists, and conditionally edits VM files", async () => {
    await computer.writeFile("project/note.txt", "hello world");
    expect(await computer.readFile("project/note.txt")).toMatchObject({
      path: "project/note.txt",
      contents: "hello world",
    });

    await computer.editFile("project/note.txt", "world", "Suma");
    expect((await computer.readFile("project/note.txt")).contents).toBe("hello Suma");
    expect((await computer.listFiles()).files).toContain("project/note.txt");

    await expect(
      computer.editFile("project/note.txt", "missing", "replacement"),
    ).rejects.toThrow("oldText was not found");
    await expect(computer.readFile("../outside.txt")).rejects.toThrow(
      "escapes the workspace",
    );
  });

  it("persists and searches memory over the VM filesystem", async () => {
    const first = await computer.addMemory("The user's preferred editor is Zed.");
    const second = await computer.addMemory("Deploy previews on Fridays.");

    expect(first.saved).toContain("preferred editor is Zed");
    expect(second.saved).toContain("Deploy previews on Fridays");
    expect((await computer.searchMemory("zed")).matches).toEqual([first.saved]);
    expect((await computer.expandMemory("1-2")).entries).toEqual([
      first.saved,
      second.saved,
    ]);
    await expect(
      computer.compressMemory("1-2", "Editor and deploy preferences."),
    ).resolves.toEqual({ result: "Saved summary for #1-2." });
  });

  it("exports the same terminal, file, and memory tool vocabulary", () => {
    expect(Object.keys(createComputerToolSet(computer)).sort()).toEqual([
      "add_memory",
      "compress_memory",
      "edit_file",
      "expand_memory",
      "kill_shell",
      "list_files",
      "list_ports",
      "open_terminal_app",
      "read_file",
      "read_terminal",
      "run_command",
      "search_memory",
      "send_keys",
      "wait_for_output",
      "write_file",
    ]);
  });
});
