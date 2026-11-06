// Per-connection, bounded LRU. Values are never shared across credentials or
// persisted to browser storage; callers decide freshness and revalidation.
export function cachePolicy(headers) {
  const policy = headers.get("Cache-Control") || "";
  const age = Number(headers.get("Age") || 0);
  const maxAge = /(?:^|,)\s*max-age\s*=\s*"?(\d+)"?/i.exec(policy);
  return {
    storable: !/\bno-store\b/i.test(policy),
    freshFor:
      /\bno-cache\b/i.test(policy) || !maxAge
        ? 0
        : Math.max(
            0,
            Math.min(
              15000,
              Number(maxAge[1]) * 1000 -
                (Number.isFinite(age) ? Math.max(0, age) * 1000 : 0),
            ),
          ),
  };
}
export class MemoryCache {
  constructor(maxBytes, maxEntries = 256) {
    this.maxBytes = maxBytes;
    this.maxEntries = maxEntries;
    this.bytes = 0;
    this.entries = new Map();
  }
  get(key) {
    const entry = this.entries.get(key);
    if (entry) {
      this.entries.delete(key);
      this.entries.set(key, entry);
    }
    return entry;
  }
  set(key, value, weight, time = Date.now()) {
    this.delete(key);
    if (!Number.isFinite(weight) || weight < 0 || weight > this.maxBytes)
      return;
    this.entries.set(key, { value, weight, time });
    this.bytes += weight;
    while (this.bytes > this.maxBytes || this.entries.size > this.maxEntries)
      this.delete(this.entries.keys().next().value);
  }
  delete(key) {
    const entry = this.entries.get(key);
    if (entry) this.bytes -= entry.weight;
    this.entries.delete(key);
  }
  expire() {
    for (const entry of this.entries.values()) entry.time = 0;
  }
  clear() {
    this.entries.clear();
    this.bytes = 0;
  }
}
