// What the records kept across sessions share: savings, activity stats and metrics, and subagents. Each session keeps
// its own record of a kind, with `since` (ms), its first count after a reset; the readout sums them.

export const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// A record whose first count came before the last reset at `resetAt` (ms) reads as `empty()`.
export const afterResetOf = (record, resetAt, empty) =>
  Number.isFinite(resetAt) && record.since !== null && record.since < resetAt ? empty() : record;

// The earlier of two `since` values, or null when neither is set.
export function earlierSince(a, b) {
  const since = [a, b].filter(Number.isFinite);
  return since.length ? Math.min(...since) : null;
}
