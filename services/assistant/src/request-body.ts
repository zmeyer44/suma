export class RequestBodyTooLargeError extends Error {}

/** Parse JSON without allowing a chunked request to bypass the size limit. */
export async function readJsonBody(
  request: Request,
  maximumBytes: number,
): Promise<unknown> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const bytes = Number(declared);
    if (Number.isFinite(bytes) && bytes > maximumBytes) {
      throw new RequestBodyTooLargeError("request body is too large");
    }
  }
  if (request.body === null) throw new SyntaxError("request body is empty");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new RequestBodyTooLargeError("request body is too large");
    }
    chunks.push(next.value);
  }
  const data = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(data)) as unknown;
}
