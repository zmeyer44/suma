import { describe, expect, it } from "vitest";
import {
  classifyWindowOpen,
  isAuthFlowUrl,
  parseFeatureSize,
  DEFAULT_POPUP_HEIGHT,
  DEFAULT_POPUP_WIDTH,
} from "../src/main/popup-policy";
import { isAllowedTabUrl } from "../src/main/tab-policy";

const open = (url: string, disposition = "foreground-tab", features = ""): ReturnType<
  typeof classifyWindowOpen
> => classifyWindowOpen({ url, disposition, features }, isAllowedTabUrl);

describe("isAuthFlowUrl", () => {
  it("recognizes the mainstream identity providers", () => {
    const urls = [
      "https://accounts.google.com/o/oauth2/v2/auth?client_id=123&response_type=code",
      "https://accounts.google.com/signin/v2/identifier",
      "https://appleid.apple.com/auth/authorize?client_id=x&response_type=code",
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=x",
      "https://github.com/login/oauth/authorize?client_id=abc",
      "https://slack.com/oauth/v2/authorize?client_id=abc",
      "https://myorg.okta.com/oauth2/v1/authorize?client_id=abc",
      "https://myorg.auth0.com/authorize?client_id=abc&response_type=code",
    ];
    for (const url of urls) expect(isAuthFlowUrl(url), url).toBe(true);
  });

  it("recognizes self-hosted identity providers by path plus OAuth params", () => {
    expect(
      isAuthFlowUrl("https://id.example.com/oauth2/authorize?client_id=x&redirect_uri=y"),
    ).toBe(true);
    expect(isAuthFlowUrl("https://example.com/sso/saml?SAMLRequest=abc")).toBe(true);
  });

  it("does not treat ordinary pages on identity hosts as auth flows", () => {
    expect(isAuthFlowUrl("https://github.com/suma/suma")).toBe(false);
    expect(isAuthFlowUrl("https://github.com/suma/suma/pull/42")).toBe(false);
    expect(isAuthFlowUrl("https://slack.com/pricing")).toBe(false);
  });

  it("ignores non-http(s) and unparseable URLs", () => {
    expect(isAuthFlowUrl("javascript:alert(1)")).toBe(false);
    expect(isAuthFlowUrl("data:text/html,<b>x</b>")).toBe(false);
    expect(isAuthFlowUrl("not a url")).toBe(false);
  });
});

describe("parseFeatureSize", () => {
  it("reads width/height from a window.open features string", () => {
    expect(parseFeatureSize("width=500,height=600,menubar=no")).toEqual({
      width: 500,
      height: 600,
    });
    expect(parseFeatureSize("popup=1")).toEqual({});
    expect(parseFeatureSize("")).toEqual({});
  });
});

describe("classifyWindowOpen", () => {
  it("gives auth ceremonies a real popup — the OAuth fix", () => {
    const decision = open(
      "https://accounts.google.com/o/oauth2/v2/auth?client_id=1&response_type=code",
      "foreground-tab",
    );
    expect(decision.disposition).toBe("popup");
    expect(decision.size).toEqual({ width: DEFAULT_POPUP_WIDTH, height: DEFAULT_POPUP_HEIGHT });
  });

  it("honors the size an auth popup asks for, clamped to sane bounds", () => {
    const sized = open(
      "https://github.com/login/oauth/authorize?client_id=a",
      "new-window",
      "width=460,height=720",
    );
    expect(sized.size).toEqual({ width: 460, height: 720 });

    const tiny = open(
      "https://github.com/login/oauth/authorize?client_id=a",
      "new-window",
      "width=1,height=1",
    );
    expect(tiny.size).toEqual({ width: 320, height: 320 });

    const huge = open(
      "https://github.com/login/oauth/authorize?client_id=a",
      "new-window",
      "width=9000,height=9000",
    );
    expect(huge.size).toEqual({ width: 1200, height: 1000 });
  });

  it("turns ordinary new pages into tabs", () => {
    expect(open("https://example.com/article", "foreground-tab").disposition).toBe("tab");
    expect(open("https://github.com/suma/suma", "foreground-tab").disposition).toBe("tab");
  });

  it("honors a deliberate non-auth popup, dimensions or not", () => {
    expect(open("https://example.com/share", "new-window", "width=400,height=300").disposition).toBe(
      "popup",
    );
    // Measured in Electron 43: `window.open(url, "_blank", "popup=1")` reports
    // new-window with no dimensions — still a popup, not a tab.
    const hinted = open("https://example.com/share", "new-window", "popup=1");
    expect(hinted.disposition).toBe("popup");
    expect(hinted.size).toEqual({ width: DEFAULT_POPUP_WIDTH, height: DEFAULT_POPUP_HEIGHT });
  });

  it("turns a shift-click (bare new-window, no features) into a glance", () => {
    expect(open("https://example.com/article", "new-window", "").disposition).toBe("glance");
    expect(open("https://example.com/article", "new-window", "   ").disposition).toBe("glance");
    // …but never an auth ceremony, which needs its live window.opener.
    expect(
      open("https://accounts.google.com/o/oauth2/v2/auth?client_id=1", "new-window", "")
        .disposition,
    ).toBe("popup");
  });

  it("previews pinned-tab links in a glance (Arc's Peek)", () => {
    const pinnedOpen = (url: string, disposition: string): ReturnType<typeof classifyWindowOpen> =>
      classifyWindowOpen(
        { url, disposition, features: "", openerPinned: true },
        isAllowedTabUrl,
      );
    // A _blank link click from a pin previews instead of adding a tab.
    expect(pinnedOpen("https://example.com/story", "foreground-tab").disposition).toBe("glance");
    // Cmd+click is a deliberate "background tab, please" — honored even there.
    expect(pinnedOpen("https://example.com/story", "background-tab").disposition).toBe("tab");
    // Auth and denied schemes are unaffected by the pin.
    expect(
      pinnedOpen("https://accounts.google.com/o/oauth2/v2/auth?client_id=1", "foreground-tab")
        .disposition,
    ).toBe("popup");
    expect(pinnedOpen("suma://settings", "foreground-tab").disposition).toBe("deny");
  });

  it("routes the shapes Chromium reports as foreground-tab to tabs", () => {
    // Bare window.open, target=_blank clicks, and noopener opens all arrive
    // as foreground-tab (measured in Electron 43).
    expect(open("https://example.com/a", "foreground-tab", "").disposition).toBe("tab");
    expect(open("https://example.com/a", "foreground-tab", "noopener").disposition).toBe("tab");
  });

  it("denies privileged schemes and blank popups", () => {
    expect(open("suma://settings").disposition).toBe("deny");
    expect(open("file:///etc/passwd").disposition).toBe("deny");
    expect(open("javascript:alert(1)").disposition).toBe("deny");
    expect(open("about:blank").disposition).toBe("deny");
    expect(open("").disposition).toBe("deny");
  });

  it("every decision carries a reason for the denied-popup toast", () => {
    for (const url of ["suma://x", "https://example.com/a", "https://accounts.google.com/signin"]) {
      expect(open(url).reason.length).toBeGreaterThan(0);
    }
  });
});
