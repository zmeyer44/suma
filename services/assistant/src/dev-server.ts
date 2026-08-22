import { serve } from "@hono/node-server";
import { Hono } from "hono";

const app = new Hono();
app.get("/healthz", (context) =>
  context.json({
    ok: true,
    mode: "local-stub",
    channels: "disabled",
    detail:
      "Run the production entry with explicit BlueBubbles and runner credentials to enable external messages.",
  }),
);

const rawPort = process.env["SUMA_ASSISTANT_PORT"] ?? "8790";
const port = Number.parseInt(rawPort, 10);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("SUMA_ASSISTANT_PORT must be an integer from 1 to 65535");
}

serve({ fetch: app.fetch, port });
console.warn(
  `assistant gateway listening on :${String(port)} in local-stub mode; external channels are disabled`,
);
