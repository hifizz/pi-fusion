export class TTLCache<T> {
  private entries = new Map<string, { value: T; expiresAt: number }>();
  private now: () => number;
  constructor(now: () => number = Date.now) { this.now = now; }
  set(key: string, value: T, ttlMs: number): void {
    if (!Number.isFinite(ttlMs) || ttlMs < 0) throw new RangeError("Invalid TTL");
    this.entries.set(key, { value, expiresAt: this.now() + ttlMs });
  }
  private liveEntry(key: string) {
    const entry = this.entries.get(key);
    if (entry && this.now() >= entry.expiresAt) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }
  get(key: string): T | undefined { return this.liveEntry(key)?.value; }
  has(key: string): boolean { return this.liveEntry(key) !== undefined; }
  size(): number {
    for (const key of this.entries.keys()) this.liveEntry(key);
    return this.entries.size;
  }
}
