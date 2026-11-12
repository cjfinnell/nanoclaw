/**
 * Delivery-id dedupe window.
 *
 * Sources occasionally redeliver (GitHub retries on non-2xx and on
 * operator redelivery). A subscription set must not wake an agent twice
 * for one logical event. In-memory LRU with a TTL — deliberately not a
 * DB table: the window is short, the cost of a rare post-restart replay
 * is one duplicate message, and keeping it out of the central DB honors
 * the minimal-scaffolding rollout decision.
 */
const TTL_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 4096;

const seen = new Map<string, number>();

/** Returns true when `id` is new (first sighting inside the window). */
export function claimDeliveryId(id: string): boolean {
  if (!id) return true; // no id → nothing to dedupe on
  const now = Date.now();
  prune(now);
  if (seen.has(id)) {
    seen.set(id, now); // refresh recency
    return false;
  }
  seen.set(id, now);
  if (seen.size > MAX_ENTRIES) {
    const oldest = seen.keys().next().value;
    if (oldest !== undefined) seen.delete(oldest);
  }
  return true;
}

function prune(now: number): void {
  for (const [id, at] of seen) {
    if (now - at > TTL_MS) seen.delete(id);
    else break; // Map iterates in insert order; first fresh entry ends the sweep
  }
}
