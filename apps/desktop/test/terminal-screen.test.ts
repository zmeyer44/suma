import { describe, expect, it } from "vitest";
import { sentinelIn } from "../src/main/shell/assistant-shell-core";
import { TerminalScreen } from "../src/main/shell/terminal-screen";

async function written(screen: TerminalScreen, data: string): Promise<void> {
  screen.write(data);
  await screen.flush();
}

describe("TerminalScreen", () => {
  it("renders ANSI-colored output as clean text", async () => {
    const screen = new TerminalScreen();
    await written(screen, "\x1b[1;32mgreen bold\x1b[0m and plain\r\nsecond\r\n");
    expect(screen.screenText()).toBe("green bold and plain\nsecond");
    screen.dispose();
  });

  it("resolves full-screen repaints to the final state", async () => {
    const screen = new TerminalScreen(40, 10);
    await written(screen, "old content\r\n");
    // A tmux-style repaint: home, clear, redraw.
    await written(screen, "\x1b[H\x1b[2Jfresh frame line 1\r\nline 2");
    expect(screen.screenText()).toBe("fresh frame line 1\nline 2");
    screen.dispose();
  });

  it("joins width-wrapped lines in tailText so long lines match whole", async () => {
    const screen = new TerminalScreen(20, 5);
    const long = "A".repeat(50);
    await written(screen, `${long}\r\n`);
    expect(screen.tailText(10)).toContain(long);
    screen.dispose();
  });

  it("detects a sentinel even when surrounding output wraps", async () => {
    const screen = new TerminalScreen(20, 5);
    await written(
      screen,
      `${"x".repeat(95)}\r\n<<SUMA-ab12cd34:7>>\r\n`,
    );
    expect(sentinelIn(screen.tailText(50), "ab12cd34")).toEqual({ exitCode: 7 });
    screen.dispose();
  });

  it("reset + replay reconstitutes the screen without duplication", async () => {
    const screen = new TerminalScreen();
    await written(screen, "first\r\nsecond\r\n");
    screen.reset();
    await written(screen, "first\r\nsecond\r\n"); // the attach replay
    expect(screen.tailText(10)).toBe("first\nsecond");
    screen.dispose();
  });

  it("tracks resizes", async () => {
    const screen = new TerminalScreen(80, 24);
    screen.resize(120, 40);
    await written(screen, "wide\r\n");
    expect(screen.screenText()).toBe("wide");
    screen.dispose();
  });
});
