import type { StoredMemoryPoint, SparseVector } from '../types.ts';
import type { VectorIndexMetrics } from '../../vectorIndex.ts';

export interface StorageFilterOptions {
    originApp?: string;
    appId?: string;
    domain?: string;
    agentRole?: string;
    minRating?: number;
    verifiedOnly?: boolean;
    includeShared?: boolean;
    targetApps?: string | string[];
}

export interface StorageQueryOptions extends StorageFilterOptions {
    limit?: number;
    scoreThreshold?: number;
    queryText?: string;
}

export interface StorageQueryResult {
    id: string;
    payload: Record<string, any>;
    vectorScore: number;
}

export interface StorageBackend {
    readonly isAvailable: boolean;
    readonly size: number;
    initialize(appId?: string): Promise<boolean>;
    store(point: StoredMemoryPoint, deduplicate?: boolean): Promise<string | null>;
    storeBatch(points: StoredMemoryPoint[]): Promise<string[]>;
    get(id: string): Promise<StoredMemoryPoint | null>;
    setPayload(id: string, payload: Partial<Record<string, any>>): Promise<boolean>;
    search(queryDense: number[], options: StorageQueryOptions, querySparse?: SparseVector): Promise<StorageQueryResult[]>;
    delete(ids: string[]): Promise<boolean>;
    wipe(appId?: string): Promise<boolean>;
    scroll(filter?: StorageFilterOptions): Promise<StoredMemoryPoint[]>;
    getIndexMetrics?(): VectorIndexMetrics;
}
