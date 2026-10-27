export class TTLCache<T> {
  private entries = new Map<string, { value: T; expiresAt: number }>();
  private now: () => number;
  constructor(now: () => number = Date.now) { this.now = now; }
  set(key: string, value: T, ttlMs: number): void {
    this.entries.set(key, {
      value, expiresAt: this.entries.get(key)?.expiresAt ?? this.now() + ttlMs,
    });
  }
  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (entry && entry.expiresAt < this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry?.value;
  }
  has(key: string): boolean { return this.get(key) !== undefined; }
  size(): number { return this.entries.size; }
}
