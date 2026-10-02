import type {
    LatencyDistribution,
    EntityMetricsBaseline,
    SwarmBaselineReport,
    TraceEvent
} from './types.ts';

export function calculateLatencyDistribution(
    latencies: number[],
    currentEma: number = 0,
    alpha: number = 0.2
): LatencyDistribution {
    if (!latencies || latencies.length === 0) {
        return {
            minMs: 0,
            maxMs: 0,
            avgMs: 0,
            p50Ms: 0,
            p90Ms: 0,
            p95Ms: 0,
            p99Ms: 0,
            emaMs: currentEma,
            sampleCount: 0
        };
    }

    const sorted = [...latencies].sort((a, b) => a - b);
    const count = sorted.length;
    const minMs = sorted[0];
    const maxMs = sorted[count - 1];
    const sum = sorted.reduce((acc, v) => acc + v, 0);
    const avgMs = Math.round(sum / count);

    const getPercentile = (p: number): number => {
        const idx = Math.min(count - 1, Math.max(0, Math.ceil((p / 100) * count) - 1));
        return sorted[idx];
    };

    return {
        minMs,
        maxMs,
        avgMs,
        p50Ms: getPercentile(50),
        p90Ms: getPercentile(90),
        p95Ms: getPercentile(95),
        p99Ms: getPercentile(99),
        emaMs: currentEma,
        sampleCount: count
    };
}

/**
 * Instruments key performance metrics (task completion rate, latency percentiles, EMA, and provider/agent baselines).
 */
export class SwarmMetricsCollector {
    private static instance: SwarmMetricsCollector;
    private latencies: number[] = [];
    private overallEma: number = 0;
    private emaAlpha: number = 0.2;
    private totalTasks: number = 0;
    private successCount: number = 0;
    private failureCount: number = 0;

    private providerRecords: Map<string, {
        latencies: number[];
        ema: number;
        successes: number;
        failures: number;
        lastError?: string;
    }> = new Map();

    private agentRecords: Map<string, {
        latencies: number[];
        ema: number;
        successes: number;
        failures: number;
        lastError?: string;
    }> = new Map();

    public constructor(alpha: number = 0.2) {
        this.emaAlpha = alpha;
    }

    public static getInstance(): SwarmMetricsCollector {
        if (!SwarmMetricsCollector.instance) {
            SwarmMetricsCollector.instance = new SwarmMetricsCollector();
        }
        return SwarmMetricsCollector.instance;
    }

    public recordTaskExecution(params: {
        success: boolean;
        durationMs: number;
        provider?: string;
        agentRole?: string;
        error?: string;
    }): void {
        const { success, durationMs, provider, agentRole, error } = params;
        const validDuration = Math.max(0, Math.round(durationMs));

        this.totalTasks++;
        if (success) {
            this.successCount++;
        } else {
            this.failureCount++;
        }

        this.latencies.push(validDuration);
        if (this.latencies.length > 1000) {
            this.latencies.shift();
        }
        if (this.overallEma === 0) {
            this.overallEma = validDuration;
        } else {
            this.overallEma = Math.round((this.emaAlpha * validDuration) + ((1 - this.emaAlpha) * this.overallEma));
        }

        if (provider) {
            const pKey = provider.toLowerCase();
            let rec = this.providerRecords.get(pKey);
            if (!rec) {
                rec = { latencies: [], ema: 0, successes: 0, failures: 0 };
                this.providerRecords.set(pKey, rec);
            }
            if (success) rec.successes++;
            else rec.failures++;
            if (error) rec.lastError = error;
            rec.latencies.push(validDuration);
            if (rec.latencies.length > 1000) {
                rec.latencies.shift();
            }
            rec.ema = rec.ema === 0 ? validDuration : Math.round((this.emaAlpha * validDuration) + ((1 - this.emaAlpha) * rec.ema));
        }

        if (agentRole) {
            const aKey = agentRole;
            let rec = this.agentRecords.get(aKey);
            if (!rec) {
                rec = { latencies: [], ema: 0, successes: 0, failures: 0 };
                this.agentRecords.set(aKey, rec);
            }
            if (success) rec.successes++;
            else rec.failures++;
            if (error) rec.lastError = error;
            rec.latencies.push(validDuration);
            if (rec.latencies.length > 1000) {
                rec.latencies.shift();
            }
            rec.ema = rec.ema === 0 ? validDuration : Math.round((this.emaAlpha * validDuration) + ((1 - this.emaAlpha) * rec.ema));
        }
    }

    public getBaselineReport(): SwarmBaselineReport {
        const overallRate = this.totalTasks > 0
            ? Math.round((this.successCount / this.totalTasks) * 10000) / 100
            : 0;

        const overallLatency = calculateLatencyDistribution(this.latencies, this.overallEma, this.emaAlpha);

        const providers: Record<string, EntityMetricsBaseline> = {};
        for (const [p, rec] of this.providerRecords.entries()) {
            const total = rec.successes + rec.failures;
            providers[p] = {
                name: p,
                totalTasks: total,
                successCount: rec.successes,
                failureCount: rec.failures,
                completionRatePercent: total > 0 ? Math.round((rec.successes / total) * 10000) / 100 : 0,
                latency: calculateLatencyDistribution(rec.latencies, rec.ema, this.emaAlpha),
                lastError: rec.lastError
            };
        }

        const agents: Record<string, EntityMetricsBaseline> = {};
        for (const [a, rec] of this.agentRecords.entries()) {
            const total = rec.successes + rec.failures;
            agents[a] = {
                name: a,
                totalTasks: total,
                successCount: rec.successes,
                failureCount: rec.failures,
                completionRatePercent: total > 0 ? Math.round((rec.successes / total) * 10000) / 100 : 0,
                latency: calculateLatencyDistribution(rec.latencies, rec.ema, this.emaAlpha),
                lastError: rec.lastError
            };
        }

        return {
            timestamp: Date.now(),
            totalTasks: this.totalTasks,
            successCount: this.successCount,
            failureCount: this.failureCount,
            overallCompletionRatePercent: overallRate,
            overallLatency,
            providers,
            agents
        };
    }

    public reset(): void {
        this.latencies = [];
        this.overallEma = 0;
        this.totalTasks = 0;
        this.successCount = 0;
        this.failureCount = 0;
        this.providerRecords.clear();
        this.agentRecords.clear();
    }

    public getSnapshot(): SwarmBaselineReport {
        return this.getBaselineReport();
    }
}

export const globalMetricsCollector = SwarmMetricsCollector.getInstance();

export class SwarmTracer {
    private static instance: SwarmTracer;
    private events: TraceEvent[] = [];
    private onEventCb?: (event: TraceEvent) => void;

    private constructor() {}

    public static getInstance(): SwarmTracer {
        if (!SwarmTracer.instance) {
            SwarmTracer.instance = new SwarmTracer();
        }
        return SwarmTracer.instance;
    }

    public setCallback(cb: (event: TraceEvent) => void) {
        this.onEventCb = cb;
    }

    public logEvent(event: Omit<TraceEvent, 'id' | 'timestamp'>) {
        const fullEvent: TraceEvent = {
            ...event,
            id: crypto.randomUUID(),
            timestamp: Date.now()
        };
        this.events.push(fullEvent);
        if (this.onEventCb) {
            this.onEventCb(fullEvent);
        }

        // Auto-instrument metrics when trace event has duration
        if (fullEvent.durationMs !== undefined && fullEvent.durationMs > 0) {
            const isFailure = !!fullEvent.error || fullEvent.action.toLowerCase().includes('failed') || fullEvent.action.toLowerCase().includes('error');
            globalMetricsCollector.recordTaskExecution({
                success: !isFailure,
                durationMs: fullEvent.durationMs,
                provider: fullEvent.provider,
                agentRole: fullEvent.agentRole,
                error: fullEvent.error
            });
        }
    }

    public dumpTrace(): TraceEvent[] {
        return this.events;
    }

    public clear() {
        this.events = [];
    }
}
