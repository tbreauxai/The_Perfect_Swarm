import { hashString } from './payloadCache.ts';

export interface GameQueryCacheEntry<T = any> {
  value: T;
  createdAt: number;
  expiresAt: number;
  hits: number;
}

export interface GameQueryCacheOptions {
  ttlMs?: number; // default: 10 minutes (600,000 ms)
  maxEntries?: number; // default: 1000
}

export interface GameQueryCacheStats {
  size: number;
  maxEntries: number;
  hits: number;
  misses: number;
  coalescedHits: number;
  evictions: number;
}

/**
 * Deterministically sort and stringify parameter objects for collision-safe hashing.
 */
export function canonicalizeParams(params?: Record<string, any> | null): string {
  if (!params || typeof params !== 'object') {
    return '{}';
  }
  const keys = Object.keys(params).sort();
  const sortedObj: Record<string, any> = {};
  for (const k of keys) {
    const val = params[k];
    if (val !== undefined) {
      sortedObj[k] = val;
    }
  }
  return JSON.stringify(sortedObj);
}

/**
 * Generates cache key: `${gameId}:${toolName}:${paramHash}`
 */
export function buildGameQueryCacheKey(
  gameId: string,
  toolName: string,
  params?: Record<string, any> | null
): string {
  const normGameId = (gameId || '').trim().toLowerCase();
  const normToolName = (toolName || '').trim().toLowerCase();
  const canonical = canonicalizeParams(params);
  const paramHash = hashString(canonical).slice(0, 16);
  return `${normGameId}:${normToolName}:${paramHash}`;
}

/**
 * GameQueryCache
 * In-memory LRU cache with 10-minute TTL and single-flight coalescing for concurrent calls.
 */
export class GameQueryCache {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly entries = new Map<string, GameQueryCacheEntry>();
  private readonly inFlight = new Map<string, Promise<any>>();

  private hits = 0;
  private misses = 0;
  private coalescedHits = 0;
  private evictions = 0;

  constructor(options: GameQueryCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? 10 * 60 * 1000; // 10 minutes default
    this.maxEntries = options.maxEntries ?? 1000;
  }

  /**
   * Retrieves an item from cache if not expired. Refreshes LRU position on hit.
   */
  get<T = any>(gameId: string, toolName: string, params?: Record<string, any> | null): T | undefined {
    const key = buildGameQueryCacheKey(gameId, toolName, params);
    const entry = this.entries.get(key);
    if (!entry) {
      this.misses++;
      return undefined;
    }

    if (Date.now() > entry.expiresAt) {
      this.entries.delete(key);
      this.misses++;
      return undefined;
    }

    // Refresh LRU order by deleting and re-inserting
    this.entries.delete(key);
    entry.hits++;
    this.entries.set(key, entry);
    this.hits++;
    return entry.value as T;
  }

  /**
   * Stores a value in the cache with LRU eviction if capacity is reached.
   */
  set<T = any>(
    gameId: string,
    toolName: string,
    params: Record<string, any> | null | undefined,
    value: T,
    customTtlMs?: number
  ): void {
    const key = buildGameQueryCacheKey(gameId, toolName, params);
    const now = Date.now();
    const ttl = customTtlMs !== undefined ? customTtlMs : this.ttlMs;

    // If key exists, delete first to refresh position
    if (this.entries.has(key)) {
      this.entries.delete(key);
    } else if (this.entries.size >= this.maxEntries) {
      // Evict oldest entry (first item in Map)
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey !== undefined) {
        this.entries.delete(oldestKey);
        this.evictions++;
      }
    }

    this.entries.set(key, {
      value,
      createdAt: now,
      expiresAt: now + ttl,
      hits: 0
    });
  }

  /**
   * Single-flight execution: Coalesces concurrent in-flight executions for identical (game_id, tool_name, params),
   * ensuring concurrent bets on the same game share one DB roundtrip.
   */
  async getOrFetch<T = any>(
    gameId: string,
    toolName: string,
    params: Record<string, any> | null | undefined,
    fetchFn: () => Promise<T>,
    customTtlMs?: number
  ): Promise<T> {
    const key = buildGameQueryCacheKey(gameId, toolName, params);

    // 1. Check existing cached item
    const cached = this.get<T>(gameId, toolName, params);
    if (cached !== undefined) {
      return cached;
    }

    // 2. Coalesce onto in-flight promise if active
    const activePromise = this.inFlight.get(key);
    if (activePromise) {
      this.coalescedHits++;
      return activePromise as Promise<T>;
    }

    // 3. Initiate single-flight execution
    const executionPromise = (async () => {
      try {
        const result = await fetchFn();
        this.set(gameId, toolName, params, result, customTtlMs);
        return result;
      } finally {
        this.inFlight.delete(key);
      }
    })();

    this.inFlight.set(key, executionPromise);
    return executionPromise;
  }

  has(gameId: string, toolName: string, params?: Record<string, any> | null): boolean {
    const key = buildGameQueryCacheKey(gameId, toolName, params);
    const entry = this.entries.get(key);
    if (!entry) return false;
    if (Date.now() > entry.expiresAt) {
      this.entries.delete(key);
      return false;
    }
    return true;
  }

  delete(gameId: string, toolName: string, params?: Record<string, any> | null): boolean {
    const key = buildGameQueryCacheKey(gameId, toolName, params);
    return this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
    this.inFlight.clear();
    this.hits = 0;
    this.misses = 0;
    this.coalescedHits = 0;
    this.evictions = 0;
  }

  size(): number {
    return this.entries.size;
  }

  getStats(): GameQueryCacheStats {
    return {
      size: this.entries.size,
      maxEntries: this.maxEntries,
      hits: this.hits,
      misses: this.misses,
      coalescedHits: this.coalescedHits,
      evictions: this.evictions
    };
  }
}

/**
 * Global singleton for game-level query cache.
 */
export const globalGameQueryCache = new GameQueryCache();
