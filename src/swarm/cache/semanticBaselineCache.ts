import { createVectorIndex, type VectorIndex } from '../vectorIndex.ts';
import type {
    SemanticCacheEntry,
    SemanticCacheStats,
    SemanticCacheConfig,
    SemanticMatchResult
} from './types.ts';
import { SemanticSimilarityEngine } from './semanticSimilarityEngine.ts';
import { hashString } from './payloadCache.ts';

/**
 * Lightweight Semantic Baseline Cache to match near-identical tasks and baseline queries,
 * immediately lowering token expenditure and bypassing redundant LLM executions.
 */
export class SemanticBaselineCache {
    private maxEntries: number;
    private defaultTtlMs: number;
    private similarityThreshold: number;
    private entries: Map<string, SemanticCacheEntry> = new Map();
    private vectorIndex: VectorIndex<SemanticCacheEntry> = createVectorIndex('vptree', { metric: 'cosine' });
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
        options?: { data?: string; ttlMs?: number; metadata?: Record<string, any>; estimatedTokens?: number; configVersion?: string }
    ): void {
        const now = Date.now();
        const duration = options?.ttlMs ?? this.defaultTtlMs;
        const normalizedTask = SemanticSimilarityEngine.normalizeText(task);
        if (!normalizedTask) return;

        const id = hashString(`semantic:${normalizedTask}`).substring(0, 32);

        if (this.entries.has(id)) {
            this.entries.delete(id);
            this.vectorIndex.delete(id);
        } else if (this.entries.size >= this.maxEntries) {
            const oldestKey = this.entries.keys().next().value;
            if (oldestKey) {
                this.entries.delete(oldestKey);
                this.vectorIndex.delete(oldestKey);
                this.evictionsCount++;
            }
        }

        const entry: SemanticCacheEntry<T> = {
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
            configVersion: options?.configVersion,
            metadata: options?.metadata
        };

        this.entries.set(id, entry);
        const vector = SemanticSimilarityEngine.computeVector(normalizedTask);
        this.vectorIndex.insert(id, vector, entry);
    }

    findMatch<T = any>(
        task: string,
        options?: { data?: string; threshold?: number; configVersion?: string }
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

        // Retrieve candidate entries: use sub-linear vector index when cache exceeds threshold
        const candidateEntries: SemanticCacheEntry<T>[] = [];
        if (this.entries.size > 20) {
            const queryVec = SemanticSimilarityEngine.computeVector(SemanticSimilarityEngine.normalizeText(task));
            const hits = this.vectorIndex.search(queryVec, { k: Math.min(25, this.entries.size) });
            for (const h of hits) {
                if (h.data) candidateEntries.push(h.data as SemanticCacheEntry<T>);
            }
        } else {
            candidateEntries.push(...(Array.from(this.entries.values()) as SemanticCacheEntry<T>[]));
        }

        for (const entry of candidateEntries) {
            if (now > entry.expiresAt) {
                this.entries.delete(entry.id);
                this.vectorIndex.delete(entry.id);
                continue;
            }

            // Config-version gate: a cached analysis is only valid for runs using the
            // same agent provider/model configuration. Stale entries from a previous
            // config are treated as misses instead of served.
            if (options?.configVersion && entry.configVersion && entry.configVersion !== options.configVersion) {
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
        this.vectorIndex.clear();
        this.hitsCount = 0;
        this.missesCount = 0;
        this.evictionsCount = 0;
        this.totalEstimatedTokensSaved = 0;
    }

    getIndexMetrics() {
        return this.vectorIndex.getMetrics();
    }
}
