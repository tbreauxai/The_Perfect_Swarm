export * from './types.ts';
export * from './semanticSimilarityEngine.ts';
export * from './payloadCache.ts';
export * from './semanticBaselineCache.ts';

import { PayloadCache } from './payloadCache.ts';
import { SemanticBaselineCache } from './semanticBaselineCache.ts';

/**
 * Global shared payload cache singleton for cross-invocation persistence.
 */
export const globalPayloadCache = new PayloadCache({ maxEntries: 300, defaultTtlMs: 60 * 60 * 1000 });

/**
 * Global shared lightweight semantic baseline cache singleton.
 */
export const globalSemanticCache = new SemanticBaselineCache({ maxEntries: 300, defaultTtlMs: 60 * 60 * 1000, similarityThreshold: 0.80 });
