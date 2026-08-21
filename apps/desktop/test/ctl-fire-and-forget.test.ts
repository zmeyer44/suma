import { describe, expect, it } from "vitest";
import { CTL_RESPONSE_TYPE } from "../src/main/compute/agent-client";
import { CTL_CAPABILITY } from "@suma/protocol";

/**
 * The ctl wire carries no request ids: responses are matched to requests
 * positionally, and an `error` frame is handed to whatever sits at the head
 * of the pending queue (agent-client.ts `onCtlFrame`). That is only sound if
 * a request nobody queued an entry for puts NOTHING on the wire — including
 * its refusals.
 *
 * The agent enforces its half in `AgentCtlRequest::awaits_response`
 * (agent/src/proto.rs, pinned by `fire_and_forget_requests_match_the_desktop`).
 * This is the desktop half: the two lists must name the same requests, or a
 * silent request grows an error frame that steals someone else's response.
 */
describe("ctl fire-and-forget contract", () => {
  const FIRE_AND_FORGET = ["pty.resize", "pty.kill", "fetch.cancel"] as const;

  it("awaits exactly the requests the agent answers", () => {
    expect(Object.keys(CTL_RESPONSE_TYPE).sort()).toEqual(
      [
        "fetch.public",
        "job.set",
        "ports.list",
        "pty.attach",
        "pty.list",
        "pty.spawn",
      ].sort(),
    );
  });

  it("leaves every fire-and-forget request without a pending entry", () => {
    for (const t of FIRE_AND_FORGET) {
      expect(CTL_RESPONSE_TYPE[t]).toBeUndefined();
    }
  });

  // CTL_CAPABILITY is keyed by every request type in the union, so this
  // fails the moment a new request lands in neither list.
  it("covers every request type in the protocol", () => {
    expect(
      [...Object.keys(CTL_RESPONSE_TYPE), ...FIRE_AND_FORGET].sort(),
    ).toEqual(Object.keys(CTL_CAPABILITY).sort());
  });
});
