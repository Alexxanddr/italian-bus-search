export class TtlCache<T> {
  readonly #entries = new Map<string, { expiresAt: number; value: T }>();
  readonly #ttlMs: number;
  readonly #maximumEntries: number;
  constructor(ttlMs: number, maximumEntries = 128) { this.#ttlMs = ttlMs; this.#maximumEntries = maximumEntries; }

  get(key: string): T | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.#entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T): void {
    const now = Date.now();
    for (const [id, entry] of this.#entries) if (entry.expiresAt <= now) this.#entries.delete(id);
    this.#entries.delete(key);
    if (this.#entries.size >= this.#maximumEntries) this.#entries.delete(this.#entries.keys().next().value!);
    this.#entries.set(key, { expiresAt: now + this.#ttlMs, value });
  }
}
