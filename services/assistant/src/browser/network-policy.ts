import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export interface BrowserNetworkPolicy {
  assertAllowed(url: string): Promise<void>;
}

export interface SafeBrowserNetworkPolicyOptions {
  /** Exact origins used for signed preview hosts and isolated local tests. */
  allowedOrigins?: readonly string[];
}

/** Blocks browser-driven SSRF on the initial URL and every subrequest. */
export class SafeBrowserNetworkPolicy implements BrowserNetworkPolicy {
  readonly #allowedOrigins: Set<string>;

  constructor(options: SafeBrowserNetworkPolicyOptions = {}) {
    this.#allowedOrigins = new Set(
      (options.allowedOrigins ?? []).map((origin) => new URL(origin).origin),
    );
  }

  async assertAllowed(rawUrl: string): Promise<void> {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`browser network policy blocks ${url.protocol} URLs`);
    }
    if (url.username !== "" || url.password !== "") {
      throw new Error("credentials in browser URLs are not allowed");
    }
    if (this.#allowedOrigins.has(url.origin)) return;

    const hostname = stripIpv6Brackets(url.hostname)
      .toLowerCase()
      .replace(/\.$/, "");
    if (
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname.endsWith(".local") ||
      hostname.endsWith(".internal") ||
      hostname === "metadata.google.internal"
    ) {
      throw new Error(`browser network policy blocks host ${hostname}`);
    }

    if (isIP(hostname) !== 0) {
      if (isBlockedAddress(hostname)) {
        throw new Error(`browser network policy blocks address ${hostname}`);
      }
      return;
    }

    const addresses = await lookup(hostname, { all: true, verbatim: true });
    if (addresses.length === 0) {
      throw new Error(`browser host ${hostname} did not resolve`);
    }
    for (const { address } of addresses) {
      if (isBlockedAddress(address)) {
        throw new Error(
          `browser network policy blocks ${hostname} because it resolves to ${address}`,
        );
      }
    }
  }
}

export function isBlockedAddress(address: string): boolean {
  const lower = stripIpv6Brackets(address).toLowerCase();
  const family = isIP(lower);
  if (family === 4) return isBlockedIpv4(lower);
  if (family !== 6) return true;

  const words = parseIpv6(lower);
  if (words === null) return true;
  const [first = 0, second = 0] = words;
  const firstSixAreZero = words.slice(0, 6).every((word) => word === 0);
  if (words.every((word) => word === 0)) return true;
  if (firstSixAreZero && words[7] === 1) return true;
  if ((first & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if ((first & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((first & 0xffc0) === 0xfec0) return true; // deprecated site-local /10
  if ((first & 0xff00) === 0xff00) return true; // multicast ff00::/8

  // IPv4-compatible and IPv4-mapped addresses. Hex and dotted forms both
  // reach the same parsed words, so ::ffff:7f00:1 cannot bypass 127/8.
  if (firstSixAreZero || (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff)) {
    return isBlockedIpv4Words(words[6] ?? 0, words[7] ?? 0);
  }
  // IPv4-translatable ::ffff:0:0:0/96.
  if (
    words.slice(0, 4).every((word) => word === 0) &&
    words[4] === 0xffff &&
    words[5] === 0
  ) {
    return isBlockedIpv4Words(words[6] ?? 0, words[7] ?? 0);
  }
  // RFC 6052 well-known NAT64 prefix. Block the local-use /48 wholesale;
  // its variable IPv4 placement is intentionally not treated as global.
  if (
    first === 0x0064 &&
    second === 0xff9b &&
    words.slice(2, 6).every((word) => word === 0)
  ) {
    return isBlockedIpv4Words(words[6] ?? 0, words[7] ?? 0);
  }
  if (first === 0x0064 && second === 0xff9b && words[2] === 1) return true;
  // 6to4 embeds IPv4 immediately after 2002::/16. Teredo can also tunnel
  // arbitrary IPv4 endpoints, so its prefix is not safe for browser egress.
  if (first === 0x2002) {
    return isBlockedIpv4Words(words[1] ?? 0, words[2] ?? 0);
  }
  if (first === 0x2001 && second === 0) return true;
  return false;
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

function parseIpv6(address: string): number[] | null {
  if (address.includes("%")) return null;
  const halves = address.split("::");
  if (halves.length > 2) return null;
  const left = parseIpv6Side(halves[0] ?? "");
  const right = parseIpv6Side(halves[1] ?? "");
  if (left === null || right === null) return null;
  if (halves.length === 1) return left.length === 8 ? left : null;
  const zeros = 8 - left.length - right.length;
  if (zeros < 1) return null;
  return [...left, ...new Array<number>(zeros).fill(0), ...right];
}

function parseIpv6Side(side: string): number[] | null {
  if (side === "") return [];
  const result: number[] = [];
  for (const token of side.split(":")) {
    if (token.includes(".")) {
      const ipv4 = parseIpv4(token);
      if (ipv4 === null) return null;
      result.push((ipv4[0] << 8) | ipv4[1], (ipv4[2] << 8) | ipv4[3]);
      continue;
    }
    if (!/^[0-9a-f]{1,4}$/u.test(token)) return null;
    result.push(Number.parseInt(token, 16));
  }
  return result;
}

function isBlockedIpv4Words(high: number, low: number): boolean {
  return isBlockedIpv4(
    `${String(high >>> 8)}.${String(high & 0xff)}.${String(low >>> 8)}.${String(low & 0xff)}`,
  );
}

function isBlockedIpv4(address: string): boolean {
  const parts = parseIpv4(address);
  if (parts === null) return true;
  const [a = 0, b = 0, c = 0] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function parseIpv4(address: string): [number, number, number, number] | null {
  const parts = address.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return null;
  }
  return parts as [number, number, number, number];
}
