/**
 * Hybrid Logical Clock (PRD §8.3, Appendix B).
 *
 * HLCs order all synced mutations. Device wall clocks are untrusted: a remote
 * timestamp may only advance our physical component by a bounded drift past
 * our own wall clock, so one device with a broken clock cannot poison
 * ordering fleet-wide.
 */

export interface Hlc {
  /** Milliseconds since epoch as observed by the issuing device. */
  physicalMs: number;
  /** Logical counter disambiguating same-millisecond events. */
  logical: number;
  /** Issuing device id — final tiebreaker so ordering is total. */
  deviceId: string;
}

/** Max amount a remote clock may pull our HLC ahead of local wall time. */
export const MAX_CLOCK_DRIFT_MS = 60_000;

export function compareHlc(a: Hlc, b: Hlc): number {
  if (a.physicalMs !== b.physicalMs) return a.physicalMs < b.physicalMs ? -1 : 1;
  if (a.logical !== b.logical) return a.logical < b.logical ? -1 : 1;
  if (a.deviceId !== b.deviceId) return a.deviceId < b.deviceId ? -1 : 1;
  return 0;
}

export function hlcEquals(a: Hlc, b: Hlc): boolean {
  return compareHlc(a, b) === 0;
}

/**
 * Lexicographically sortable string form: zero-padded hex physical (14 nibbles
 * covers year ~10889), hex logical (8 nibbles), then device id.
 */
export function encodeHlc(h: Hlc): string {
  const p = h.physicalMs.toString(16).padStart(14, "0");
  const l = h.logical.toString(16).padStart(8, "0");
  return `${p}-${l}-${h.deviceId}`;
}

export function decodeHlc(s: string): Hlc {
  const first = s.indexOf("-");
  const second = s.indexOf("-", first + 1);
  if (first !== 14 || second !== 23) throw new Error(`malformed HLC: ${s}`);
  const physicalMs = Number.parseInt(s.slice(0, first), 16);
  const logical = Number.parseInt(s.slice(first + 1, second), 16);
  const deviceId = s.slice(second + 1);
  if (Number.isNaN(physicalMs) || Number.isNaN(logical) || deviceId.length === 0) {
    throw new Error(`malformed HLC: ${s}`);
  }
  return { physicalMs, logical, deviceId };
}

export class HlcClock {
  private lastPhysicalMs = 0;
  private lastLogical = 0;

  constructor(
    public readonly deviceId: string,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Issue a timestamp for a local event. */
  send(): Hlc {
    const wall = this.now();
    if (wall > this.lastPhysicalMs) {
      this.lastPhysicalMs = wall;
      this.lastLogical = 0;
    } else {
      this.lastLogical += 1;
    }
    return { physicalMs: this.lastPhysicalMs, logical: this.lastLogical, deviceId: this.deviceId };
  }

  /**
   * Merge a remote timestamp. The remote physical component is clamped to
   * local-wall-time + MAX_CLOCK_DRIFT_MS before merging (untrusted clocks).
   */
  receive(remote: Hlc): Hlc {
    const wall = this.now();
    const remotePhysical = Math.min(remote.physicalMs, wall + MAX_CLOCK_DRIFT_MS);
    const maxPhysical = Math.max(wall, remotePhysical, this.lastPhysicalMs);
    let logical: number;
    if (maxPhysical === this.lastPhysicalMs && maxPhysical === remotePhysical) {
      logical = Math.max(this.lastLogical, remote.logical) + 1;
    } else if (maxPhysical === this.lastPhysicalMs) {
      logical = this.lastLogical + 1;
    } else if (maxPhysical === remotePhysical) {
      logical = remote.logical + 1;
    } else {
      logical = 0;
    }
    this.lastPhysicalMs = maxPhysical;
    this.lastLogical = logical;
    return { physicalMs: maxPhysical, logical, deviceId: this.deviceId };
  }

  /** Restore persisted clock state (used when draining the offline queue after restart). */
  restore(last: Hlc): void {
    if (
      last.physicalMs > this.lastPhysicalMs ||
      (last.physicalMs === this.lastPhysicalMs && last.logical > this.lastLogical)
    ) {
      this.lastPhysicalMs = last.physicalMs;
      this.lastLogical = last.logical;
    }
  }
}
