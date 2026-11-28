/**
 * In-memory rate limiter using a sliding-window counter.
 *
 * Cloudflare Workers isolates are single-threaded and can be evicted between
 * requests, so this provides best-effort protection rather than a hard global
 * cap.  For strict rate limiting add Cloudflare's Rate Limiting product
 * (available on the free plan up to 10k requests/month, then paid).
 *
 * The in-memory approach is free, requires no external state, and is
 * sufficient for most abuse prevention on a personal gateway.
 */

const windows = new Map(); // clientKey → { count, windowStart }

export function checkRateLimit(clientKey, maxRequests, windowMs) {
  const now = Date.now();
  let w = windows.get(clientKey);

  if (!w || now - w.windowStart >= windowMs) {
    w = { count: 0, windowStart: now };
  }

  w.count++;
  windows.set(clientKey, w);

  const remaining = Math.max(0, maxRequests - w.count);
  const resetAt = w.windowStart + windowMs;

  if (w.count > maxRequests) {
    return {
      limited: true,
      remaining: 0,
      resetAt,
      retryAfter: Math.ceil((resetAt - now) / 1000),
    };
  }

  return { limited: false, remaining, resetAt };
}

/** Prune stale entries to prevent unbounded memory growth. */
export function pruneWindows(windowMs) {
  const cutoff = Date.now() - windowMs;
  for (const [k, w] of windows.entries()) {
    if (w.windowStart < cutoff) windows.delete(k);
  }
}
