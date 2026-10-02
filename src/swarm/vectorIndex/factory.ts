import type { VectorIndex, VpTreeConfig, HnswConfig } from './types.ts';
import { VpTreeIndex } from './vpTreeIndex.ts';
import { HnswVectorIndex } from './hnswIndex.ts';

/**
 * Factory helper to construct the appropriate vector index.
 */
export function createVectorIndex<T = any>(
    type: 'vptree' | 'hnsw' = 'vptree',
    config?: VpTreeConfig | HnswConfig
): VectorIndex<T> {
    if (type === 'hnsw') {
        return new HnswVectorIndex<T>(config as HnswConfig);
    }
    return new VpTreeIndex<T>(config as VpTreeConfig);
}
