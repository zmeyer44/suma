/**
 * "What kind of file is this?" for the suma://terminal IDE — magic-byte
 * sniffing shared by WorkspaceFsService (which decides what to send the
 * editor) and the suma-workspace:// media handler (which decides what it is
 * willing to stream at all).
 *
 * Extensions are not trusted: a ".png" that is really a zip must not reach an
 * <img>, and a screenshot saved without an extension should still render. The
 * one exception is documented on the MP3 branch below.
 *
 * Pure and dependency-free on purpose — both callers must reach the same
 * verdict for the same bytes, or the editor would show a player for a file the
 * protocol then refuses to serve.
 */

/** How much of a file's head is enough for every check here. */
export const SNIFF_BYTES = 4_096;

/** NUL in the head of a file is the classic "this is not text" heuristic. */
export function looksBinary(head: Buffer): boolean {
  return head.subarray(0, 8_000).includes(0);
}

/** The DIB header sizes BMP writers actually emit (BITMAPCOREHEADER → V5). */
const DIB_HEADER_SIZES: ReadonlySet<number> = new Set([
  12, 40, 52, 56, 64, 108, 124,
]);

function startsWith(buffer: Buffer, bytes: readonly number[]): boolean {
  if (buffer.length < bytes.length) return false;
  return bytes.every((byte, i) => buffer[i] === byte);
}

function tag(head: Buffer, start: number, end: number): string {
  return head.subarray(start, end).toString("latin1");
}

/**
 * The image type, or null. Only formats Chromium decodes are listed.
 *
 * SVG is deliberately absent — it is text, and an IDE is more useful showing
 * its source than a picture of it.
 */
export function sniffImageMime(head: Buffer): string | null {
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    return "image/png";
  if (startsWith(head, [0xff, 0xd8, 0xff])) return "image/jpeg";
  const gifHead = tag(head, 0, 6);
  if (gifHead === "GIF87a" || gifHead === "GIF89a") return "image/gif";
  // "BM" alone is two bytes a text file could open with; require a real DIB
  // header size behind it.
  if (
    startsWith(head, [0x42, 0x4d]) &&
    head.length >= 18 &&
    DIB_HEADER_SIZES.has(head.readUInt32LE(14))
  )
    return "image/bmp";
  if (startsWith(head, [0x00, 0x00, 0x01, 0x00])) return "image/x-icon";
  // RIFF and ISO-BMFF both carry their format tag past the leading size field.
  if (tag(head, 0, 4) === "RIFF" && tag(head, 8, 12) === "WEBP")
    return "image/webp";
  // HEIC shares this container but Chromium has no decoder for it, so it stays
  // a binary notice rather than a broken image.
  if (tag(head, 4, 8) === "ftyp") {
    const brand = tag(head, 8, 12);
    if (brand === "avif" || brand === "avis") return "image/avif";
  }
  return null;
}

/**
 * The audio type, or null. `rel` is consulted for exactly one case (see the
 * MP3 branch) and is otherwise ignored.
 */
export function sniffAudioMime(head: Buffer, rel: string): string | null {
  if (tag(head, 0, 4) === "OggS") return "audio/ogg";
  if (tag(head, 0, 4) === "fLaC") return "audio/flac";
  if (tag(head, 0, 4) === "RIFF" && tag(head, 8, 12) === "WAVE")
    return "audio/wav";
  if (tag(head, 0, 3) === "ID3") return "audio/mpeg";
  if (tag(head, 4, 8) === "ftyp") {
    const brand = tag(head, 8, 12);
    if (brand === "M4A " || brand === "M4B ") return "audio/mp4";
  }
  // ADTS AAC and a raw MP3 frame share the 0xFF sync byte and are told apart
  // by the layer bits: 00 is reserved in MPEG audio and means ADTS, while
  // MP3 is layer III.
  if (head.length >= 2) {
    const b1 = head[1] ?? 0;
    if (head[0] === 0xff && (b1 & 0xf6) === 0xf0) return "audio/aac";
    // A bare MP3 frame (no ID3 tag) is only an 11-bit sync word — far too weak
    // to hand arbitrary binaries to a decoder on, so it counts only when the
    // name agrees. Tagged MP3s, the overwhelming majority, matched above.
    if (head[0] === 0xff && (b1 & 0xe0) === 0xe0 && /\.mp3$/i.test(rel))
      return "audio/mpeg";
  }
  return null;
}
