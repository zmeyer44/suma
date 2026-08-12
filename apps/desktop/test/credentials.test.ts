import { describe, expect, it } from "vitest";
import {
  buildFillScript,
  credentialItemsForHost,
  opGetArgs,
  OP_LIST_ARGS,
  parseOpFields,
} from "../src/main/credentials-core";

function opItem(id: string, title: string, hrefs: string[], username?: string): unknown {
  return {
    id,
    title,
    urls: hrefs.map((href) => ({ href })),
    ...(username === undefined ? {} : { additional_information: username }),
  };
}

describe("op argv", () => {
  it("lists Login items as JSON without any host filter (filtered client-side)", () => {
    expect(OP_LIST_ARGS).toEqual(["item", "list", "--categories", "Login", "--format", "json"]);
  });

  it("fetches exactly the username/password fields for one item", () => {
    const args = opGetArgs("item-42");
    expect(args).toContain("item-42");
    expect(args).toContain("label=username,label=password");
    expect(args).toContain("--reveal");
  });
});

describe("credentialItemsForHost", () => {
  const vault = [
    opItem("1", "GitHub", ["https://github.com/login"], "octo@example.com"),
    opItem("2", "GitLab", ["https://gitlab.com"], "dev@example.com"),
    opItem("3", "Bank", ["https://www.bank.example/auth"]),
    opItem("4", "Bare", ["bank.example"]),
    opItem("5", "No urls", []),
  ];

  it("matches the exact host", () => {
    const items = credentialItemsForHost(vault, "github.com");
    expect(items).toEqual([{ id: "1", title: "GitHub", username: "octo@example.com" }]);
  });

  it("matches across www and subdomains, both directions", () => {
    expect(credentialItemsForHost(vault, "bank.example").map((i) => i.id)).toEqual(["3", "4"]);
    expect(credentialItemsForHost(vault, "online.bank.example").map((i) => i.id)).toEqual([
      "3",
      "4",
    ]);
    expect(credentialItemsForHost(vault, "gist.github.com").map((i) => i.id)).toEqual(["1"]);
  });

  it("returns nothing for unrelated hosts or malformed json", () => {
    expect(credentialItemsForHost(vault, "example.org")).toEqual([]);
    expect(credentialItemsForHost({ not: "an array" }, "github.com")).toEqual([]);
    expect(credentialItemsForHost([{ id: 1 }], "github.com")).toEqual([]);
  });

  it("defaults username to empty when op has none", () => {
    expect(credentialItemsForHost(vault, "www.bank.example")[0]?.username).toBe("");
  });
});

describe("parseOpFields", () => {
  it("parses username/password field objects", () => {
    expect(
      parseOpFields([
        { id: "username", label: "username", value: "octo" },
        { id: "password", label: "password", value: "s3cret" },
      ]),
    ).toEqual({ username: "octo", password: "s3cret" });
  });

  it("returns null without a password", () => {
    expect(parseOpFields([{ label: "username", value: "octo" }])).toBeNull();
    expect(parseOpFields("nope")).toBeNull();
  });
});

describe("buildFillScript", () => {
  it("embeds values via JSON so quotes cannot break out of the literal", () => {
    const password = `pa"ss</script>\\`;
    const script = buildFillScript("user@example.com", password);
    expect(script).toContain(JSON.stringify(password));
    expect(script).toContain(JSON.stringify("user@example.com"));
    // The raw double quote must only ever appear JSON-escaped (\").
    expect(script).not.toContain(`pa"ss`);
  });

  it("targets the focused password input and dispatches framework events", () => {
    const script = buildFillScript("u", "p");
    expect(script).toContain('input[type="password"]');
    expect(script).toContain("document.activeElement");
    expect(script).toContain('new Event("input", { bubbles: true })');
    expect(script).toContain('new Event("change", { bubbles: true })');
  });
});
