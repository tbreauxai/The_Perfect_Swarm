/**
 * High-performance, deterministic structured payload cache with LRU eviction and TTL expiration.
 * Prevents LLM context window drift, duplicate token expenditures, and redundant network calls
 * across identical or repetitive analysis tasks.
 */

export interface CacheEntry<T = any> {
    fingerprint: string;
    payload: T;
    createdAt: number;
    expiresAt: number;
    hits: number;
    lastAccessedAt: number;
    metadata?: Record<string, any>;
}

export interface PayloadCacheConfig {
    maxEntries?: number;       // default: 250
    defaultTtlMs?: number;     // default: 15 minutes (900,000 ms)
}

export interface CacheStats {
    size: number;
    maxEntries: number;
    hits: number;
    misses: number;
    evictions: number;
    hitRatio: number;
}

export interface FingerprintOptions {
    appId?: string;
    deepAnalysis?: boolean;
    forceFullSwarm?: boolean;
    complexity?: string;
    model?: string;
}

export class PayloadCache {
    private maxEntries: number;
    private defaultTtlMs: number;
    private entries: Map<string, CacheEntry> = new Map();
    private hitsCount: number = 0;
    private missesCount: number = 0;
    private evictionsCount: number = 0;

    constructor(config?: PayloadCacheConfig) {
        this.maxEntries = config?.maxEntries ?? 250;
        this.defaultTtlMs = config?.defaultTtlMs ?? 15 * 60 * 1000;
    }

    /**
     * Computes a deterministic 64-character hex fingerprint of the input task, payload, and options.
     * Guarantees identical fingerprints across Node.js, browsers, and edge runtimes with zero dependencies.
     */
    static computeFingerprint(task: string, data: string = "", options?: FingerprintOptions): string {
        const canonical = [
            `app:${options?.appId || 'default'}`,
            `task:${(task || '').trim()}`,
            `data:${(data || '').trim()}`,
            `complexity:${options?.complexity || 'auto'}`,
            `deep:${Boolean(options?.deepAnalysis)}`,
            `forceFullSwarm:${Boolean(options?.forceFullSwarm)}`,
            `model:${options?.model || 'default'}`
        ].join('||');

        return PayloadCache.hashString(canonical);
    }

    /**
     * Pure TypeScript 64-character deterministic dual-state hash.
     * High entropy, collision-resistant, and completely portable.
     */
    static hashString(str: string): string {
        let h1 = 0x811c9dc5 ^ str.length;
        let h2 = 0xdeadbeef ^ str.length;
        let h3 = 0x41c6ce57 ^ str.length;
        let h4 = 0x9e3779b9 ^ str.length;

        for (let i = 0; i < str.length; i++) {
            const ch = str.charCodeAt(i);
            h1 = Math.imul(h1 ^ ch, 16777619);
            h2 = Math.imul(h2 ^ ch, 2654435761);
            h3 = Math.imul(h3 ^ ch, 1597334677);
            h4 = Math.imul(h4 ^ ch, 2246822507);
        }

        h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
        h2 = Math.imul(h2 ^ (h2 >>> 16), 1597334677) ^ Math.imul(h3 ^ (h3 >>> 13), 2654435761);
        h3 = Math.imul(h3 ^ (h3 >>> 16), 2654435761) ^ Math.imul(h4 ^ (h4 >>> 13), 16777619);
        h4 = Math.imul(h4 ^ (h4 >>> 16), 3266489909) ^ Math.imul(h1 ^ (h1 >>> 13), 2246822507);

        const hex1 = (h1 >>> 0).toString(16).padStart(8, '0');
        const hex2 = (h2 >>> 0).toString(16).padStart(8, '0');
        const hex3 = (h3 >>> 0).toString(16).padStart(8, '0');
        const hex4 = (h4 >>> 0).toString(16).padStart(8, '0');

        // Repeat mix to output 64-character fingerprint
        const p1 = `${hex1}${hex2}${hex3}${hex4}`;
        let rev1 = 0x5bd1e995;
        for (let i = 0; i < p1.length; i++) {
            rev1 = Math.imul(rev1 ^ p1.charCodeAt(i), 1540483477);
        }
        const hex5 = (rev1 >>> 0).toString(16).padStart(8, '0');
        const hex6 = ((rev1 * 31) >>> 0).toString(16).padStart(8, '0');
        const hex7 = ((rev1 * 127) >>> 0).toString(16).padStart(8, '0');
        const hex8 = ((rev1 * 8191) >>> 0).toString(16).padStart(8, '0');

        return `${hex1}${hex2}${hex3}${hex4}${hex5}${hex6}${hex7}${hex8}`;
    }

    /**
     * Retrieves a cached payload by its deterministic fingerprint.
     * Updates LRU order and returns null if expired or missing.
     */
    get<T = any>(fingerprint: string): T | null {
        const entry = this.entries.get(fingerprint);
        if (!entry) {
            this.missesCount++;
            return null;
        }

        const now = Date.now();
        if (now > entry.expiresAt) {
            this.entries.delete(fingerprint);
            this.missesCount++;
            return null;
        }

        // Cache hit: update LRU position by re-inserting to end of Map
        entry.hits++;
        entry.lastAccessedAt = now;
        this.entries.delete(fingerprint);
        this.entries.set(fingerprint, entry);

        this.hitsCount++;
        return entry.payload as T;
    }

    /**
     * Stores an analysis payload under the given fingerprint with LRU eviction and TTL expiration.
     */
    set<T = any>(fingerprint: string, payload: T, ttlMs?: number, metadata?: Record<string, any>): void {
        const now = Date.now();
        const duration = ttlMs ?? this.defaultTtlMs;

        // If key exists, delete it first so insertion moves to end of Map
        if (this.entries.has(fingerprint)) {
            this.entries.delete(fingerprint);
        } else if (this.entries.size >= this.maxEntries) {
            // Evict least-recently-used entry (first key in Map iterator)
            const oldestKey = this.entries.keys().next().value;
            if (oldestKey) {
                this.entries.delete(oldestKey);
                this.evictionsCount++;
            }
        }

        this.entries.set(fingerprint, {
            fingerprint,
            payload,
            createdAt: now,
            expiresAt: now + duration,
            hits: 0,
            lastAccessedAt: now,
            metadata
        });
    }

    /**
     * Checks whether an unexpired entry exists for the fingerprint.
     */
    has(fingerprint: string): boolean {
        const entry = this.entries.get(fingerprint);
        if (!entry) return false;
        if (Date.now() > entry.expiresAt) {
            this.entries.delete(fingerprint);
            return false;
        }
        return true;
    }

    /**
     * Invalidates a specific fingerprint.
     */
    invalidate(fingerprint: string): boolean {
        return this.entries.delete(fingerprint);
    }

    private semanticCache?: SemanticBaselineCache;

    /**
     * Obtains the dedicated semantic baseline cache instance.
     */
    getSemanticCache(): SemanticBaselineCache {
        if (!this.semanticCache) {
            this.semanticCache = new SemanticBaselineCache();
        }
        return this.semanticCache;
    }

    /**
     * Looks up an existing analysis payload matching the semantic intent of the task.
     */
    findSemanticMatch<T = any>(task: string, options?: { data?: string; threshold?: number }): SemanticMatchResult<T> {
        return this.getSemanticCache().findMatch<T>(task, options);
    }

    /**
     * Stores an analysis payload into the semantic baseline cache.
     */
    setSemantic<T = any>(task: string, payload: T, options?: { data?: string; ttlMs?: number; metadata?: Record<string, any> }): void {
        this.getSemanticCache().set<T>(task, payload, options);
    }

    /**
     * Clears all cached payloads and resets counters.
     */
    clear(): void {
        this.entries.clear();
        this.hitsCount = 0;
        this.missesCount = 0;
        this.evictionsCount = 0;
        if (this.semanticCache) {
            this.semanticCache.clear();
        }
    }

    /**
     * Returns cache performance statistics.
     */
    getStats(): CacheStats {
        const total = this.hitsCount + this.missesCount;
        return {
            size: this.entries.size,
            maxEntries: this.maxEntries,
            hits: this.hitsCount,
            misses: this.missesCount,
            evictions: this.evictionsCount,
            hitRatio: total === 0 ? 0 : Number((this.hitsCount / total).toFixed(4))
        };
    }
}

export interface SemanticCacheEntry<T = any> {
    id: string;
    task: string;
    dataSample: string;
    normalizedTask: string;
    taskTokens: string[];
    taskTrigrams: Set<string>;
    payload: T;
    createdAt: number;
    expiresAt: number;
    hits: number;
    lastAccessedAt: number;
    metadata?: Record<string, any>;
}

export interface SemanticCacheStats {
    size: number;
    maxEntries: number;
    hits: number;
    misses: number;
    evictions: number;
    hitRatio: number;
    estimatedTokensSaved: number;
}

export interface SemanticCacheConfig {
    maxEntries?: number;          // default: 200
    defaultTtlMs?: number;        // default: 30 minutes (1,800,000 ms)
    similarityThreshold?: number; // default: 0.80 (80% similarity required for hit)
}

export interface SemanticMatchResult<T = any> {
    hit: boolean;
    entry?: SemanticCacheEntry<T>;
    similarity: number;
    matchedTask?: string;
    reason?: string;
}

/**
 * High-performance, zero-dependency lexical-semantic similarity engine.
 * Combines token set Jaccard matching with character trigram Dice coefficient.
 */
export class SemanticSimilarityEngine {
    private static STOP_WORDS = new Set([
        'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from',
        'has', 'he', 'in', 'is', 'it', 'its', 'of', 'on', 'that', 'the',
        'to', 'was', 'were', 'will', 'with', 'this', 'but', 'they',
        'have', 'had', 'what', 'when', 'where', 'who', 'which', 'why', 'how'
    ]);

    static normalizeText(text: string): string {
        return (text || '')
            .toLowerCase()
            .replace(/[^\w\s]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    static tokenize(text: string): string[] {
        const normalized = this.normalizeText(text);
        if (!normalized) return [];
        return normalized
            .split(' ')
            .filter(w => w.length > 1 && !this.STOP_WORDS.has(w));
    }

    static extractTrigrams(text: string): Set<string> {
        const normalized = this.normalizeText(text);
        const trigrams = new Set<string>();
        if (normalized.length < 3) {
            if (normalized.length > 0) trigrams.add(normalized);
            return trigrams;
        }
        for (let i = 0; i <= normalized.length - 3; i++) {
            trigrams.add(normalized.substring(i, i + 3));
        }
        return trigrams;
    }

    static tokenSimilarity(tokensA: string[], tokensB: string[]): number {
        if (tokensA.length === 0 && tokensB.length === 0) return 1.0;
        if (tokensA.length === 0 || tokensB.length === 0) return 0.0;

        const setB = new Set(tokensB);
        let matchScore = 0;
        const matchedB = new Set<string>();

        for (const tA of tokensA) {
            if (setB.has(tA)) {
                matchScore += 1.0;
                matchedB.add(tA);
            } else {
                for (const tB of tokensB) {
                    if (!matchedB.has(tB)) {
                        let commonPrefixLen = 0;
                        const minLen = Math.min(tA.length, tB.length);
                        while (commonPrefixLen < minLen && tA[commonPrefixLen] === tB[commonPrefixLen]) {
                            commonPrefixLen++;
                        }
                        if (commonPrefixLen >= 4 || (commonPrefixLen >= 3 && (tA.startsWith(tB) || tB.startsWith(tA)))) {
                            matchScore += 0.85;
                            matchedB.add(tB);
                            break;
                        }
                        if (tA.length >= 4 && tB.length >= 4 && (tA.includes(tB) || tB.includes(tA))) {
                            matchScore += 0.75;
                            matchedB.add(tB);
                            break;
                        }
                    }
                }
            }
        }

        const totalTokens = Math.max(tokensA.length, tokensB.length);
        return totalTokens === 0 ? 0 : Math.min(1.0, matchScore / totalTokens);
    }

    static trigramDice(trigramsA: Set<string>, trigramsB: Set<string>): number {
        if (trigramsA.size === 0 && trigramsB.size === 0) return 1.0;
        if (trigramsA.size === 0 || trigramsB.size === 0) return 0.0;

        let intersection = 0;
        for (const tri of trigramsA) {
            if (trigramsB.has(tri)) intersection++;
        }

        return (2 * intersection) / (trigramsA.size + trigramsB.size);
    }

    static computeSimilarity(
        taskA: string,
        taskB: string,
        precomputed?: {
            tokensA?: string[];
            trigramsA?: Set<string>;
            tokensB?: string[];
            trigramsB?: Set<string>;
        }
    ): number {
        const tokensA = precomputed?.tokensA ?? this.tokenize(taskA);
        const trigramsA = precomputed?.trigramsA ?? this.extractTrigrams(taskA);

        const tokensB = precomputed?.tokensB ?? this.tokenize(taskB);
        const trigramsB = precomputed?.trigramsB ?? this.extractTrigrams(taskB);

        const tokenSim = this.tokenSimilarity(tokensA, tokensB);
        const dice = this.trigramDice(trigramsA, trigramsB);

        const score = (tokenSim * 0.60) + (dice * 0.40);
        return Math.round(score * 1000) / 1000;
    }
}

/**
 * Lightweight Semantic Baseline Cache to match near-identical tasks and baseline queries,
 * immediately lowering token expenditure and bypassing redundant LLM executions.
 */
export class SemanticBaselineCache {
    private maxEntries: number;
    private defaultTtlMs: number;
    private similarityThreshold: number;
    private entries: Map<string, SemanticCacheEntry> = new Map();
    private hitsCount: number = 0;
    private missesCount: number = 0;
    private evictionsCount: number = 0;
    private totalEstimatedTokensSaved: number = 0;

    constructor(config?: SemanticCacheConfig) {
        this.maxEntries = config?.maxEntries ?? 200;
        this.defaultTtlMs = config?.defaultTtlMs ?? 30 * 60 * 1000;
        this.similarityThreshold = config?.similarityThreshold ?? 0.80;
    }

    set<T = any>(
        task: string,
        payload: T,
        options?: { data?: string; ttlMs?: number; metadata?: Record<string, any>; estimatedTokens?: number }
    ): void {
        const now = Date.now();
        const duration = options?.ttlMs ?? this.defaultTtlMs;
        const normalizedTask = SemanticSimilarityEngine.normalizeText(task);
        if (!normalizedTask) return;

        const id = PayloadCache.hashString(`semantic:${normalizedTask}`).substring(0, 32);

        if (this.entries.has(id)) {
            this.entries.delete(id);
        } else if (this.entries.size >= this.maxEntries) {
            const oldestKey = this.entries.keys().next().value;
            if (oldestKey) {
                this.entries.delete(oldestKey);
                this.evictionsCount++;
            }
        }

        this.entries.set(id, {
            id,
            task,
            dataSample: (options?.data || '').substring(0, 500),
            normalizedTask,
            taskTokens: SemanticSimilarityEngine.tokenize(task),
            taskTrigrams: SemanticSimilarityEngine.extractTrigrams(task),
            payload,
            createdAt: now,
            expiresAt: now + duration,
            hits: 0,
            lastAccessedAt: now,
            metadata: options?.metadata
        });
    }

    findMatch<T = any>(
        task: string,
        options?: { data?: string; threshold?: number }
    ): SemanticMatchResult<T> {
        const threshold = options?.threshold ?? this.similarityThreshold;
        const now = Date.now();

        if (!task || this.entries.size === 0) {
            this.missesCount++;
            return { hit: false, similarity: 0 };
        }

        let bestMatch: SemanticCacheEntry<T> | undefined;
        let highestSimilarity = 0;

        const queryTokens = SemanticSimilarityEngine.tokenize(task);
        const queryTrigrams = SemanticSimilarityEngine.extractTrigrams(task);

        for (const [id, entry] of this.entries.entries()) {
            if (now > entry.expiresAt) {
                this.entries.delete(id);
                continue;
            }

            const sim = SemanticSimilarityEngine.computeSimilarity(
                task,
                entry.task,
                {
                    tokensA: queryTokens,
                    trigramsA: queryTrigrams,
                    tokensB: entry.taskTokens,
                    trigramsB: entry.taskTrigrams
                }
            );

            if (sim > highestSimilarity) {
                highestSimilarity = sim;
                bestMatch = entry as SemanticCacheEntry<T>;
            }
        }

        if (bestMatch && highestSimilarity >= threshold) {
            this.entries.delete(bestMatch.id);
            bestMatch.hits++;
            bestMatch.lastAccessedAt = now;
            this.entries.set(bestMatch.id, bestMatch);

            this.hitsCount++;
            const estTokens = Math.max(50, Math.ceil((task.length + (options?.data?.length || 0)) / 4));
            this.totalEstimatedTokensSaved += estTokens;

            return {
                hit: true,
                entry: bestMatch,
                similarity: highestSimilarity,
                matchedTask: bestMatch.task,
                reason: `Semantic match with ${(highestSimilarity * 100).toFixed(1)}% confidence against baseline '${bestMatch.task.substring(0, 50)}'`
            };
        }

        this.missesCount++;
        return {
            hit: false,
            similarity: highestSimilarity,
            matchedTask: bestMatch?.task,
            reason: highestSimilarity > 0 ? `Highest similarity ${(highestSimilarity * 100).toFixed(1)}% fell below threshold ${(threshold * 100).toFixed(0)}%` : 'No similar baseline found'
        };
    }

    getStats(): SemanticCacheStats {
        const total = this.hitsCount + this.missesCount;
        return {
            size: this.entries.size,
            maxEntries: this.maxEntries,
            hits: this.hitsCount,
            misses: this.missesCount,
            evictions: this.evictionsCount,
            hitRatio: total === 0 ? 0 : Number((this.hitsCount / total).toFixed(4)),
            estimatedTokensSaved: this.totalEstimatedTokensSaved
        };
    }

    clear(): void {
        this.entries.clear();
        this.hitsCount = 0;
        this.missesCount = 0;
        this.evictionsCount = 0;
        this.totalEstimatedTokensSaved = 0;
    }
}

/**
 * Global shared payload cache singleton for cross-invocation persistence.
 */
export const globalPayloadCache = new PayloadCache({ maxEntries: 300, defaultTtlMs: 60 * 60 * 1000 });

/**
 * Global shared lightweight semantic baseline cache singleton.
 */
export const globalSemanticCache = new SemanticBaselineCache({ maxEntries: 300, defaultTtlMs: 60 * 60 * 1000, similarityThreshold: 0.80 });
