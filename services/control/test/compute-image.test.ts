import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dockerfile = readFileSync(
  new URL("../../../infra/compute-image/Dockerfile", import.meta.url),
  "utf8",
);
const agentMain = readFileSync(
  new URL("../../../agent/src/main.rs", import.meta.url),
  "utf8",
);

describe("compute image runtime contract", () => {
  it("uses kernel socket tables for listening-port discovery", () => {
    expect(agentMain).toContain("use suma_agent::ports::ProcSource;");
    expect(agentMain).toContain("ports: Box::new(ProcSource)");
  });

  it("defaults the agent to a dual-stack listener", () => {
    expect(dockerfile).toContain("ENV SUMA_AGENT_LISTEN=[::]:2222");
  });

  it("ships tmux for agent-independent terminal sessions", () => {
    expect(dockerfile).toMatch(/\n\s+tmux\s+\\/);
    expect(agentMain).toContain("PtyManager::new_persistent");
  });
});
