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
 * - If Qdrant is unconfigured or unreachable, the store disables itself and the
 *   system keeps its previous in-memory-only behavior (with a warning).
 * - Point IDs are deterministic (record id / ledger key / role / generation) so
 *   retries and re-saves are idempotent upserts, never duplicates.
 */

import { QdrantClient } from '@qdrant/js-client-rest';

export const LEARNING_COLLECTION = 'swarm_learning';
const VECTOR_SIZE = 8;
const QDRANT_TIMEOUT_MS = 8000;

function dummyVector(): number[] {
    return new Array(VECTOR_SIZE).fill(0);
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
}

export interface RestoredLearningState {
    outcomes: Record<string, any>[];
    ledger: Record<string, Record<string, any>>;
    profiles: Record<string, Record<string, any>>;
    policies: { generation: number; policy: any; reward: number; timestamp: number }[];
}

const EMPTY_STATE: RestoredLearningState = { outcomes: [], ledger: {}, profiles: {}, policies: [] };

export class QdrantLearningStore {
    public enabled = false;
    private client: any = null;
    private collection: string;
    private readyPromise: Promise<boolean>;

    constructor(config: LearningStoreConfig = {}) {
        const safeEnv: Record<string, string | undefined> =
            typeof process !== 'undefined' && (process as any).env ? (process as any).env : {};
        this.collection = config.collection || LEARNING_COLLECTION;

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
    }

    private async upsert(id: string, payload: Record<string, any>): Promise<void> {
        const ok = await this.readyPromise;
        if (!ok || !this.client) return;
        try {
            await withTimeout(
                this.client.upsert(this.collection, {
                    wait: false,
                    points: [{ id, vector: dummyVector(), payload }]
                }),
                QDRANT_TIMEOUT_MS,
                'upsert'
            );
        } catch (err) {
            this.warn('upsert', err);
        }
    }

    /** Persist a full outcome record (idempotent by record.id). */
    public saveOutcome(record: Record<string, any>): Promise<void> {
        if (!record || !record.id) return Promise.resolve();
        return this.upsert(String(record.id), {
            kind: 'outcome',
            appId: record.appId || 'default',
            workflowId: record.workflowId || '',
            ts: record.timestamp || Date.now(),
            data: record
        });
    }

    /** Persist one analyst-ledger entry, keyed `${appId}:${agentRole}`. */
    public saveLedgerEntry(key: string, entry: Record<string, any>): Promise<void> {
        if (!key) return Promise.resolve();
        return this.upsert(`ledger:${key}`, {
            kind: 'ledger',
            key,
            ts: entry.lastUpdated || Date.now(),
            data: entry
        });
    }

    /** Persist one specialist accuracy profile, keyed by agent role. */
    public saveProfile(agentRole: string, profile: Record<string, any>): Promise<void> {
        const role = (agentRole || '').trim();
        if (!role) return Promise.resolve();
        return this.upsert(`profile:${role}`, {
            kind: 'profile',
            role,
            ts: profile.lastUpdated || Date.now(),
            data: profile
        });
    }

    /** Persist one policy-genealogy generation. */
    public savePolicyGeneration(generation: number, policy: any, reward: number): Promise<void> {
        return this.upsert(`policy:gen:${generation}`, {
            kind: 'policy',
            generation,
            ts: Date.now(),
            data: { generation, policy, reward, timestamp: Date.now() }
        });
    }

    /** Load every persisted learning record. Never rejects; returns empty state on failure. */
    public async loadAll(): Promise<RestoredLearningState> {
        const state: RestoredLearningState = { outcomes: [], ledger: {}, profiles: {}, policies: [] };
        const ok = await this.readyPromise;
        if (!ok || !this.client) return state;
        try {
            let offset: any = undefined;
            for (;;) {
                const res: any = await withTimeout(
                    this.client.scroll(this.collection, {
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
                    else if (p.kind === 'profile' && p.role && p.data) state.profiles[p.role] = p.data;
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
