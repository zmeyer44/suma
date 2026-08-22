import { describe, expect, it } from "vitest";
import {
  ASSISTANT_TOOL_GROUP_IDS,
  assistantToolGroupDefaultEnabled,
  assistantToolGroupOf,
  isAssistantToolGroupId,
} from "../src/tool-groups";

describe("assistant tool groups", () => {
  it("keeps browser navigation and interaction capabilities explicit", () => {
    expect(assistantToolGroupOf("navigate")).toBe("navigate");
    expect(assistantToolGroupOf("go_back")).toBe("history");
    expect(assistantToolGroupOf("click")).toBe("interact");
    expect(assistantToolGroupOf("type_text")).toBe("interact");
  });

  it("rejects unknown settings groups", () => {
    expect(isAssistantToolGroupId("terminal")).toBe(true);
    expect(isAssistantToolGroupId("admin")).toBe(false);
    expect(new Set(ASSISTANT_TOOL_GROUP_IDS).size).toBe(
      ASSISTANT_TOOL_GROUP_IDS.length,
    );
  });

  it("does not silently enable newly introduced history controls", () => {
    expect(assistantToolGroupDefaultEnabled("navigate")).toBe(true);
    expect(assistantToolGroupDefaultEnabled("history")).toBe(false);
  });
});
