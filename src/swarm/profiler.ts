export interface DataProfile {
    charCount: number;
    estimatedTokens: number;
    rowCount: number;
    format: 'JSON' | 'Text/CSV';
}

export interface ChunkingResult {
    chunks: string[];
    originalChunkCount: number;
    maxTokensPerChunk: number;
    totalTokens: number;
    warning?: string;
}

export const DEFAULT_MAX_CHARS = 500000;
export const DEFAULT_MAX_TOKENS_PER_CHUNK = 8000; // Calibrated for free-tier quotas
export const DEFAULT_MAX_CHUNKS = 8; // Expanded from 4 to 8 to support deep metadata payloads

/**
 * Extracts metadata and profiles the input data payload.
 */
export function profileData(data: string, maxChars: number = DEFAULT_MAX_CHARS): { rawInput: string; profile: DataProfile } {
    let rawInput = data || "";
    if (rawInput.length > maxChars) {
        rawInput = rawInput.substring(0, maxChars) + "\n...[TRUNCATED FOR MEMORY SAFETY]...";
    }

    const charCount = rawInput.length;
    const estimatedTokens = Math.ceil(charCount / 4);
    const rowCount = rawInput.split('\n').length;
    const trimmed = rawInput.trim();
    const isJson = trimmed.startsWith('{') || trimmed.startsWith('[');

    return {
        rawInput,
        profile: {
            charCount,
            estimatedTokens,
            rowCount,
            format: isJson ? 'JSON' : 'Text/CSV'
        }
    };
}

/**
 * Splits raw input into token-budgeted chunks respecting free-tier API quotas and HTTP timeout thresholds.
 */
export function createTokenChunks(
    rawInput: string,
    maxTokensPerChunk: number = DEFAULT_MAX_TOKENS_PER_CHUNK,
    maxChunks: number = DEFAULT_MAX_CHUNKS
): ChunkingResult {
    const rawLines = rawInput.split('\n');
    const maxCharsPerChunk = maxTokensPerChunk * 4;
    const normalizedLines: string[] = [];

    for (const line of rawLines) {
        if (line.length <= maxCharsPerChunk) {
            normalizedLines.push(line);
        } else {
            // Segment ultra-long line (e.g. minified JSON or unformatted logs)
            for (let offset = 0; offset < line.length; offset += maxCharsPerChunk) {
                normalizedLines.push(line.substring(offset, offset + maxCharsPerChunk));
            }
        }
    }

    const chunks: string[] = [];
    let currentChunk = "";
    let currentTokens = 0;

    for (const line of normalizedLines) {
        const lineTokens = Math.ceil(line.length / 4);

        if (currentTokens + lineTokens > maxTokensPerChunk && currentChunk.length > 0) {
            chunks.push(currentChunk.trim());
            currentChunk = "";
            currentTokens = 0;
        }

        currentChunk += line + "\n";
        currentTokens += lineTokens;
    }

    if (currentChunk.trim().length > 0) {
        chunks.push(currentChunk.trim());
    }

    if (chunks.length === 0) {
        chunks.push("");
    }

    const originalChunkCount = chunks.length;
    let warning: string | undefined = undefined;

    if (chunks.length > maxChunks) {
        warning = `Payload exceeded ${maxChunks} batches (${originalChunkCount} chunks detected). Analysis balanced to preserve opening structure, representative sampling, and closing metadata trailer.`;
        if (maxChunks <= 1) {
            chunks.length = 1;
        } else if (maxChunks === 2) {
            const first = chunks[0];
            const last = chunks[chunks.length - 1];
            chunks.length = 0;
            chunks.push(first, last);
        } else {
            const first = chunks.slice(0, maxChunks - 1);
            const last = chunks[chunks.length - 1];
            chunks.length = 0;
            chunks.push(...first, last);
        }
    }

    const totalTokens = chunks.reduce((acc, c) => acc + Math.ceil(c.length / 4), 0);

    return {
        chunks,
        originalChunkCount,
        maxTokensPerChunk,
        totalTokens,
        warning
    };
}

export interface TraceEvent {
    id: string;
    timestamp: number;
    agentRole?: string;
    action: string;
    modelName?: string;
    provider?: string;
    durationMs?: number;
    error?: string;
    payload?: any;
}

export interface LatencyDistribution {
    minMs: number;
    maxMs: number;
    avgMs: number;
    p50Ms: number;
    p90Ms: number;
    p95Ms: number;
    p99Ms: number;
    emaMs: number;
    sampleCount: number;
}

export interface EntityMetricsBaseline {
    name: string;
    totalTasks: number;
    successCount: number;
    failureCount: number;
    completionRatePercent: number;
    latency: LatencyDistribution;
    lastError?: string;
}

export interface SwarmBaselineReport {
    timestamp: number;
    totalTasks: number;
    successCount: number;
    failureCount: number;
    overallCompletionRatePercent: number;
    overallLatency: LatencyDistribution;
    providers: Record<string, EntityMetricsBaseline>;
    agents: Record<string, EntityMetricsBaseline>;
}

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
            id: Math.random().toString(36).substring(7),
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
