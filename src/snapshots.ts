import { randomUUID } from "node:crypto";
import { AppError, type ProviderError } from "./domain.ts";
import { TtlCache } from "./cache.ts";

type Result<T> = { journeys: T[]; errors: ProviderError[] };
export type PageOptions = { snapshot?: boolean; searchId?: string; offset: number; limit: number; hasQuery: boolean };

export class SearchSnapshots {
  // shortcut: snapshots belong to one process; use shared storage before adding replicas.
  readonly #cache = new TtlCache<{ kind: string; json: string; createdAt: string; expiresAt: string }>(300_000, 32);

  async page<T>(kind: "bus" | "train", load: () => Promise<Result<T>>, options: PageOptions): Promise<Result<T> & { total: number; truncated: boolean; searchId?: string; createdAt?: string; expiresAt?: string }> {
    const { searchId, snapshot, offset, limit, hasQuery } = options;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new AppError("INVALID_INPUT", "offset must be non-negative and limit must be between 1 and 50", 400);
    if (searchId !== undefined) {
      if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(searchId)) throw new AppError("INVALID_INPUT", "searchId must be a UUID", 400);
      if (hasQuery) throw new AppError("INVALID_INPUT", "Use searchId with offset/limit only; start a new search to change query parameters", 400);
      const stored = this.#cache.get(searchId);
      if (stored === undefined || stored.kind !== kind) throw new AppError("SEARCH_EXPIRED", "Search expired or unavailable; start a new search", 410);
      return { ...page(JSON.parse(stored.json) as Result<T>, offset, limit), searchId, createdAt: stored.createdAt, expiresAt: stored.expiresAt };
    }
    if (snapshot && offset !== 0) throw new AppError("INVALID_INPUT", "A new snapshot must start at offset 0", 400);
    const result = await load();
    if (!snapshot) return page(result, offset, limit);
    const json = JSON.stringify(result);
    if (Buffer.byteLength(json) > 1_048_576) throw new AppError("SEARCH_TOO_LARGE", "Search exceeds the snapshot size limit; narrow the query", 413);
    const createdAt = new Date().toISOString(), expiresAt = new Date(Date.now() + 300_000).toISOString(), id = randomUUID();
    this.#cache.set(id, { kind, json, createdAt, expiresAt });
    return { ...page(JSON.parse(json) as Result<T>, offset, limit), searchId: id, createdAt, expiresAt };
  }
}

function page<T>(result: Result<T>, offset: number, limit: number) {
  return { journeys: result.journeys.slice(offset, offset + limit), errors: result.errors, total: result.journeys.length, truncated: result.journeys.length > offset + limit };
}
