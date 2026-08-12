/** Header carrying the edge-verified deviceId to the DO. Always stripped from
 * the client request so it can never be spoofed.
 *
 * Lives here rather than in the Worker entry module: workerd treats every
 * named export of the entry as an entrypoint and refuses to start the
 * runtime when one is not a handler or class. */
export const DEVICE_HEADER = "x-suma-device";

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
