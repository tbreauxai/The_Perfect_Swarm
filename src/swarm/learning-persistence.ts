/**
 * @file learning-persistence.ts
 * @description Durable persistence for the swarm's learning state.
 *
 * The learning loop (outcome records, analyst ledger, specialist accuracy profiles,
 * policy genealogy) historically lived in pure in-memory Maps, so every backend
 * redeploy/restart wiped the swarm's accumulated learning. This module backs those
 * structures with Qdrant (already a configured dependency via QDRANT_URL/QDRANT_API_KEY),
 * which survives redeploys, restarts, and refreshes.
 *
 * Design rules:
 * - Qdrant is a durable *backup*; in-memory Maps stay the read path (zero latency impact).
 * - All writes are fire-and-forget with timeouts and never throw into request handling.
 * - Writes are batched in-memory with a debounce timer and explicit flush().
 * - If Qdrant is unconfigured or unreachable, the store disables itself and the
 *   system keeps its previous in-memory-only behavior (with a warning).
 * - Point IDs are deterministic (record id / ledger key / role / generation) so
 *   retries and re-saves are idempotent upserts, never duplicates.
 */

import crypto from 'crypto';
import { QdrantClient } from '@qdrant/js-client-rest';

export const LEARNING_COLLECTION = 'swarm_learning';
export const LEARNING_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const VECTOR_SIZE = 8;
const QDRANT_TIMEOUT_MS = 8000;
const BATCH_FLUSH_WINDOW_MS = 35;
const MAX_BATCH_SIZE = 50;

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function dummyVector(): number[] {
    const val = 1 / Math.sqrt(VECTOR_SIZE);
    return new Array(VECTOR_SIZE).fill(val);
}

function parseUuidToBytes(uuid: string): Buffer {
    const hex = uuid.replace(/-/g, '');
    return Buffer.from(hex, 'hex');
}

/**
 * Deterministically generates an RFC 4122 compliant UUIDv5 string from a name and namespace.
 */
export function toUuidV5(name: string, namespace: string = LEARNING_NAMESPACE): string {
    const nsBytes = parseUuidToBytes(namespace);
    const nameBytes = Buffer.from(name, 'utf8');
    const hash = crypto.createHash('sha1').update(Buffer.concat([nsBytes, nameBytes])).digest();

    // Set version 5 (0101 in bits 4-7 of octet 6)
    hash[6] = (hash[6] & 0x0f) | 0x50;
    // Set variant RFC 4122 (10 in bits 6-7 of octet 8)
    hash[8] = (hash[8] & 0x3f) | 0x80;

    const hex = hash.subarray(0, 16).toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function ensureUuid(idOrKey: string): string {
    if (UUID_REGEX.test(idOrKey)) {
        return idOrKey;
    }
    return toUuidV5(idOrKey);
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: any;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`[LearningPersistence] ${label} timed out after ${ms}ms`)), ms);
    });
    return Promise.race([
        promise.finally(() => clearTimeout(timer)),
        timeout
    ]) as Promise<T>;
}

export interface LearningStoreConfig {
    url?: string;
    apiKey?: string;
    collection?: string;
    /** Inject a fake client in tests. */
    client?: any;
    debounceMs?: number;
    maxBatchSize?: number;
}

export interface RestoredLearningState {
    outcomes: Record<string, any>[];
    ledger: Record<string, Record<string, any>>;
    profiles: Record<string, Record<string, any>>;
    policies: { generation: number; policy: any; reward: number; timestamp: number }[];
}

export class QdrantLearningStore {
    public enabled = false;
    private client: any = null;
    private collection: string;
    private readyPromise: Promise<boolean>;
    private writeBuffer: Array<{ id: string; payload: Record<string, any> }> = [];
    private flushTimer: any = null;
    private debounceMs: number;
    private maxBatchSize: number;

    constructor(config: LearningStoreConfig = {}) {
        const safeEnv: Record<string, string | undefined> =
            typeof process !== 'undefined' && (process as any).env ? (process as any).env : {};
        this.collection = config.collection || LEARNING_COLLECTION;
        this.debounceMs = config.debounceMs ?? BATCH_FLUSH_WINDOW_MS;
        this.maxBatchSize = config.maxBatchSize ?? MAX_BATCH_SIZE;

        if (config.client) {
            this.client = config.client;
            this.readyPromise = this.ensureCollection()
                .then(() => { this.enabled = true; return true; })
                .catch((err) => { this.warn('init', err); return false; });
            return;
        }

        const url = config.url || safeEnv.QDRANT_URL;
        const apiKey = config.apiKey || safeEnv.QDRANT_API_KEY;
        if (!url) {
            this.readyPromise = Promise.resolve(false);
            return;
        }
        try {
            new URL(url);
            this.client = new QdrantClient({ url, apiKey, checkCompatibility: false });
            this.readyPromise = this.ensureCollection()
                .then(() => { this.enabled = true; return true; })
                .catch((err) => { this.warn('init', err); this.client = null; return false; });
        } catch (err) {
            this.warn('init', err);
            this.readyPromise = Promise.resolve(false);
        }
    }

    /** Resolves true when the store is usable (collection exists). Never rejects. */
    public whenReady(): Promise<boolean> {
        return this.readyPromise;
    }

    private warn(op: string, err: any): void {
        console.warn(`[LearningPersistence] Qdrant ${op} failed — learning state stays in-memory only:`, err?.message || err);
    }

    private async ensureCollection(): Promise<void> {
        const cols: any = await withTimeout(this.client.getCollections(), QDRANT_TIMEOUT_MS, 'getCollections');
        const exists = (cols?.collections || []).some((c: any) => c.name === this.collection);
        if (!exists) {
            await withTimeout(
                this.client.createCollection(this.collection, {
                    vectors: { size: VECTOR_SIZE, distance: 'Cosine' }
                }),
                QDRANT_TIMEOUT_MS,
                'createCollection'
            );
        }

        if (typeof this.client.createPayloadIndex === 'function') {
            try {
                await withTimeout(
                    this.client.createPayloadIndex(this.collection, {
                        field_name: 'ts',
                        field_schema: 'integer'
                    }),
                    QDRANT_TIMEOUT_MS,
                    'createPayloadIndex'
                );
            } catch {
                // Idempotent: ignore if index already exists
            }
        }
    }

    /**
     * Explicitly commits all pending buffered writes immediately.
     * Essential for process exit, test completion, and serverless response delivery.
     */
    public async flush(): Promise<void> {
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }

        if (!this.enabled) {
            const ok = await this.readyPromise;
            if (!ok) {
                this.writeBuffer = [];
                return;
            }
        }

        if (this.writeBuffer.length === 0 || !this.client) return;

        const batch = this.writeBuffer.splice(0, this.writeBuffer.length);
        const points = batch.map(item => ({
            id: item.id,
            vector: dummyVector(),
            payload: item.payload
        }));

        try {
            await withTimeout(
                this.client.upsert(this.collection, {
                    wait: false,
                    points
                }),
                QDRANT_TIMEOUT_MS,
                'upsertBatch'
            );
        } catch (err) {
            this.warn('upsertBatch', err);
        }
    }

    private async upsert(id: string, payload: Record<string, any>): Promise<void> {
        if (!this.client) return;

        if (!this.enabled) {
            const ok = await this.readyPromise;
            if (!ok || !this.client) return;
        }

        // Deduplicate within the write buffer by deterministic ID
        const existingIdx = this.writeBuffer.findIndex(item => item.id === id);
        if (existingIdx >= 0) {
            this.writeBuffer[existingIdx] = { id, payload };
        } else {
            this.writeBuffer.push({ id, payload });
        }

        if (this.writeBuffer.length >= this.maxBatchSize) {
            await this.flush();
        } else if (!this.flushTimer) {
            this.flushTimer = setTimeout(() => {
                this.flushTimer = null;
                this.flush().catch(err => this.warn('flush', err));
            }, this.debounceMs);
            if (this.flushTimer && typeof this.flushTimer.unref === 'function') {
                this.flushTimer.unref();
            }
        }
    }

    /** Persist a full outcome record (idempotent by record.id). */
    public saveOutcome(record: Record<string, any>): Promise<void> {
        if (!record || !record.id) return Promise.resolve();
        const rawId = String(record.id);
        const pointId = ensureUuid(rawId);
        return this.upsert(pointId, {
            kind: 'outcome',
            key: rawId,
            originalKey: rawId,
            appId: record.appId || 'default',
            workflowId: record.workflowId || '',
            ts: record.timestamp || Date.now(),
            data: record
        });
    }

    /** Persist one analyst-ledger entry, keyed `${appId}:${agentRole}`. */
    public saveLedgerEntry(key: string, entry: Record<string, any>): Promise<void> {
        if (!key) return Promise.resolve();
        const textId = `ledger:${key}`;
        const pointId = toUuidV5(textId);
        return this.upsert(pointId, {
            kind: 'ledger',
            key,
            originalKey: textId,
            ts: entry.lastUpdated || Date.now(),
            data: entry
        });
    }

    /** Persist one specialist accuracy profile, keyed by agent role. */
    public saveProfile(agentRole: string, profile: Record<string, any>): Promise<void> {
        const role = (agentRole || '').trim();
        if (!role) return Promise.resolve();
        const textId = `profile:${role}`;
        const pointId = toUuidV5(textId);
        return this.upsert(pointId, {
            kind: 'profile',
            role,
            key: role,
            originalKey: textId,
            ts: profile.lastUpdated || Date.now(),
            data: profile
        });
    }

    /** Persist one policy-genealogy generation. */
    public savePolicyGeneration(generation: number, policy: any, reward: number): Promise<void> {
        const textId = `policy:gen:${generation}`;
        const pointId = toUuidV5(textId);
        return this.upsert(pointId, {
            kind: 'policy',
            generation,
            key: textId,
            originalKey: textId,
            ts: Date.now(),
            data: { generation, policy, reward, timestamp: Date.now() }
        });
    }

    /**
     * Load persisted learning records.
     * Optional sinceTimestamp filter loads only records updated after that timestamp.
     * Default undefined loads all historical records (full restore for cold starts).
     */
    public async loadAll(sinceTimestamp?: number): Promise<RestoredLearningState> {
        const state: RestoredLearningState = { outcomes: [], ledger: {}, profiles: {}, policies: [] };
        const ok = await this.readyPromise;
        if (!ok || !this.client) return state;

        const filter = sinceTimestamp !== undefined
            ? { must: [{ key: 'ts', range: { gte: sinceTimestamp } }] }
            : undefined;

        try {
            let offset: any = undefined;
            for (;;) {
                const res: any = await withTimeout(
                    this.client.scroll(this.collection, {
                        filter,
                        limit: 500,
                        offset,
                        with_payload: true,
                        with_vector: false
                    }),
                    QDRANT_TIMEOUT_MS,
                    'scroll'
                );
                for (const pt of res?.points || []) {
                    const p = (pt.payload || {}) as any;
                    if (p.kind === 'outcome' && p.data) state.outcomes.push(p.data);
                    else if (p.kind === 'ledger' && p.key && p.data) state.ledger[p.key] = p.data;
                    else if (p.kind === 'profile' && (p.role || p.key) && p.data) state.profiles[p.role || p.key] = p.data;
                    else if (p.kind === 'policy' && p.data) state.policies.push(p.data);
                }
                offset = res?.next_page_offset;
                if (offset === undefined || offset === null) break;
            }
            state.policies.sort((a, b) => a.generation - b.generation);
        } catch (err) {
            this.warn('load', err);
        }
        return state;
    }
}
