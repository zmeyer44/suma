/**
 * Trailing-edge throttle: at most one call per `intervalMs`, and a call that
 * arrives inside the window is not dropped — it fires once, at the window's
 * end. Built for the explorer's refresh: file-change signals arrive in
 * bursts, the refetch is idempotent, and the LAST signal must always produce
 * a refetch or the tree ends stale.
 */
export function throttleTrailing(fn: () => void, intervalMs: number): () => void {
  let lastRun = Number.NEGATIVE_INFINITY;
  let timer: ReturnType<typeof setTimeout> | null = null;
  return () => {
    const now = Date.now();
    if (now - lastRun >= intervalMs && timer === null) {
      lastRun = now;
      fn();
      return;
    }
    if (timer !== null) return; // trailing call already scheduled
    timer = setTimeout(
      () => {
        timer = null;
        lastRun = Date.now();
        fn();
      },
      Math.max(0, intervalMs - (now - lastRun)),
    );
  };
}
