import { rankAndFilterCandidates } from '../tags.ts';
import type { StorageQueryResult } from '../storage/types.ts';
import type { RetrievalOptions, RrfWeights, RrfProfile } from '../types.ts';
import { RRF_PRESETS } from '../types.ts';

export interface RrfRankerConfig {
    rrfK?: number;
    defaultWeights?: RrfWeights;
}

export interface FusionOptions {
    denseHits: StorageQueryResult[];
    sparseHits?: StorageQueryResult[];
    weights?: RrfWeights;
    profile?: RrfProfile;
    limit?: number;
}

export interface FusedCandidate extends StorageQueryResult {
    denseRank?: number;
    sparseRank?: number;
    rrfScore: number;
}

export class RrfRanker {
    private readonly rrfK: number;
    private readonly defaultWeights: RrfWeights;

    constructor(config: RrfRankerConfig = {}) {
        this.rrfK = config.rrfK ?? 60;
        this.defaultWeights = config.defaultWeights ?? {
            dense: 0.6,
            sparse: 0.4
        };
    }

    /**
     * Resolves weights from an explicit object, a named profile, or defaults.
     */
    resolveWeights(weights?: RrfWeights, profile?: RrfProfile): { dense: number; sparse: number } {
        if (weights) {
            const dense = weights.dense ?? weights.vector ?? 0.6;
            const sparse = weights.sparse ?? weights.lexical ?? 0.4;
            const total = dense + sparse;
            return total > 0 ? { dense: dense / total, sparse: sparse / total } : { dense: 0.6, sparse: 0.4 };
        }

        if (profile && RRF_PRESETS[profile]) {
            const preset = RRF_PRESETS[profile];
            const dense = preset.dense ?? preset.vector ?? 0.6;
            const sparse = preset.sparse ?? preset.lexical ?? 0.4;
            const total = dense + sparse;
            return total > 0 ? { dense: dense / total, sparse: sparse / total } : { dense: 0.6, sparse: 0.4 };
        }

        return {
            dense: this.defaultWeights.dense ?? 0.6,
            sparse: this.defaultWeights.sparse ?? 0.4
        };
    }

    /**
     * Fuses dense and sparse candidate result sets using the Reciprocal Rank Fusion (RRF) algorithm:
     * RRF(d) = w_dense / (k + rank_dense(d)) + w_sparse / (k + rank_sparse(d))
     */
    fuse(options: FusionOptions): FusedCandidate[] {
        const { denseHits, sparseHits = [], weights, profile, limit } = options;
        const resolvedWeights = this.resolveWeights(weights, profile);
        const candidateMap = new Map<string, FusedCandidate>();

        // Dense ranking pass
        const sortedDense = [...denseHits].sort((a, b) => b.vectorScore - a.vectorScore);
        sortedDense.forEach((hit, idx) => {
            const rank = idx + 1;
            const rrfContribution = resolvedWeights.dense / (this.rrfK + rank);

            candidateMap.set(hit.id, {
                id: hit.id,
                payload: hit.payload,
                vectorScore: hit.vectorScore,
                denseRank: rank,
                rrfScore: rrfContribution
            });
        });

        // Sparse ranking pass
        const sortedSparse = [...sparseHits].sort((a, b) => b.vectorScore - a.vectorScore);
        sortedSparse.forEach((hit, idx) => {
            const rank = idx + 1;
            const rrfContribution = resolvedWeights.sparse / (this.rrfK + rank);

            const existing = candidateMap.get(hit.id);
            if (existing) {
                existing.sparseRank = rank;
                existing.rrfScore += rrfContribution;
            } else {
                candidateMap.set(hit.id, {
                    id: hit.id,
                    payload: hit.payload,
                    vectorScore: hit.vectorScore,
                    sparseRank: rank,
                    rrfScore: rrfContribution
                });
            }
        });

        const fused = Array.from(candidateMap.values())
            .sort((a, b) => b.rrfScore - a.rrfScore);

        if (limit !== undefined && limit > 0) {
            return fused.slice(0, limit);
        }

        return fused;
    }

    /**
     * Filters and ranks candidates using domain affinity, multi-tenant isolation, facts vs judgments, and recency.
     */
    rankAndFilter(
        candidates: StorageQueryResult[],
        options: RetrievalOptions & { query?: string },
        defaultAppId: string = 'default'
    ): any[] {
        const scoredCandidates = candidates.map(c => ({
            id: c.id,
            payload: {
                id: c.id,
                ...c.payload
            },
            vectorScore: c.vectorScore
        }));

        return rankAndFilterCandidates(
            scoredCandidates,
            options,
            options.query || '',
            defaultAppId
        );
    }
}
