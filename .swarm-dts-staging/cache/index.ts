export * from './types.js';
export * from './semanticSimilarityEngine.js';
export * from './payloadCache.js';
export * from './semanticBaselineCache.js';

import { PayloadCache } from './payloadCache.js';
import { SemanticBaselineCache } from './semanticBaselineCache.js';

/**
 * Global shared payload cache singleton for cross-invocation persistence.
 */
export const globalPayloadCache = new PayloadCache({ maxEntries: 300, defaultTtlMs: 60 * 60 * 1000 });

/**
 * Global shared lightweight semantic baseline cache singleton.
 */
export const globalSemanticCache = new SemanticBaselineCache({ maxEntries: 300, defaultTtlMs: 60 * 60 * 1000, similarityThreshold: 0.80 });
