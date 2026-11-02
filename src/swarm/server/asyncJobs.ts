/**
 * Opt-in async replies (Prefer: respond-async) for long swarm calls, so Cloudflare's 100 s limit
 * never cuts a reply (524). Jobs live in process memory on the single Render web instance.
 * Every job promise is tracked and settles into the store; errors are caught and logged, never dropped.
 */

export type AsyncJobStatus = 'pending' | 'done' | 'error';

export interface AsyncJobRecord {
    status: AsyncJobStatus;
    ownerAppId: string;
    createdAt: number;
    finishedAt?: number;
    result?: unknown;
    error?: string;
}

export const ASYNC_JOB_TTL_MS = 60 * 60 * 1000;
export const ASYNC_JOB_MAX_ENTRIES = 500;

/** True when the request opts in with `Prefer: respond-async`. */
export function wantsAsync(c: any): boolean {
    const prefer = String(c?.req?.header?.('Prefer') || '');
    return prefer.split(/[,;]/).some((t) => t.trim().toLowerCase() === 'respond-async');
}

export function newJobId(prefix: string, nowMs: number): string {
    return `${prefix}-${nowMs}-${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
}

export class AsyncJobStore {
    private readonly jobs = new Map<string, AsyncJobRecord>();
    private readonly inflight = new Set<Promise<void>>();
    private readonly now: () => number;

    constructor(now: () => number = Date.now) {
        this.now = now;
    }

    /** Registers a pending job and runs it in the background. Never throws; failures land as status 'error'. */
    start(id: string, ownerAppId: string, run: () => Promise<unknown>): void {
        this.prune();
        this.jobs.set(id, { status: 'pending', ownerAppId, createdAt: this.now() });
        const p: Promise<void> = Promise.resolve()
            .then(run)
            .then(
                (result) => {
                    this.finish(id, { status: 'done', result });
                },
                (err: any) => {
                    console.error(`[SwarmServer Async Job Error] ${id}:`, err);
                    this.finish(id, { status: 'error', error: err?.message || String(err) });
                },
            )
            .catch((err: any) => {
                console.error(`[SwarmServer Async Job Store Error] ${id}:`, err);
            })
            .finally(() => {
                this.inflight.delete(p);
            });
        this.inflight.add(p);
    }

    /** The job as seen by its owner; undefined if unknown, expired, or owned by another app. */
    get(id: string, ownerAppId: string): AsyncJobRecord | undefined {
        this.prune();
        const job = this.jobs.get(id);
        if (!job || job.ownerAppId !== ownerAppId) return undefined;
        return job;
    }

    /** Resolves when every background job has settled (tests and graceful shutdown). */
    async drain(): Promise<void> {
        while (this.inflight.size > 0) {
            await Promise.all([...this.inflight]);
        }
    }

    size(): number {
        return this.jobs.size;
    }

    private finish(id: string, patch: Partial<AsyncJobRecord>): void {
        const job = this.jobs.get(id);
        if (!job) return;
        this.jobs.set(id, { ...job, ...patch, finishedAt: this.now() });
    }

    private prune(): void {
        const t = this.now();
        for (const [id, job] of this.jobs) {
            if (job.finishedAt !== undefined && t - job.finishedAt > ASYNC_JOB_TTL_MS) this.jobs.delete(id);
        }
        if (this.jobs.size < ASYNC_JOB_MAX_ENTRIES) return;
        const finished = [...this.jobs.entries()]
            .filter(([, j]) => j.finishedAt !== undefined)
            .sort((a, b) => (a[1].finishedAt as number) - (b[1].finishedAt as number));
        for (const [id] of finished) {
            if (this.jobs.size < ASYNC_JOB_MAX_ENTRIES) break;
            this.jobs.delete(id);
        }
    }
}

/** Process-wide store shared by /analyze, /morning and the status route. */
export const globalAsyncJobs = new AsyncJobStore();
