export interface NodeCapacityConfig {
    defaultMaxConcurrency?: number;               // default 5
    nodeConcurrencyLimits?: Record<string, number>; // per-node or per-provider concurrency limits
    saturationThreshold?: number;                 // threshold ratio (e.g. 0.90 or 1.0) for saturation flag
}

export interface CapacitySlot {
    slotId: string;
    nodeKey: string;
    acquiredAt: number;
    weight: number;
    metadata?: Record<string, any>;
    release: () => void;
}

export interface NodeCapacityMetrics {
    nodeKey: string;
    maxConcurrency: number;
    activeInFlight: number;
    availableHeadroom: number;
    utilizationRatio: number;      // 0.0 to 1.0
    utilizationPercent: number;    // 0 to 100
    isSaturated: boolean;
    totalSlotsAcquired: number;
    totalSlotsReleased: number;
}

/**
 * Manages per-node and per-provider concurrency capacity, tracks in-flight workload slots,
 * and calculates real-time node capacity headroom to prevent resource exhaustion and 429 bottlenecks.
 */
export class NodeCapacityManager {
    private concurrencyLimits: Map<string, number> = new Map();
    private activeSlots: Map<string, Map<string, CapacitySlot>> = new Map();
    private totalAcquiredCount: Map<string, number> = new Map();
    private totalReleasedCount: Map<string, number> = new Map();
    private defaultMaxConcurrency: number;
    private saturationThreshold: number;

    constructor(config?: NodeCapacityConfig) {
        this.defaultMaxConcurrency = config?.defaultMaxConcurrency ?? 5;
        this.saturationThreshold = config?.saturationThreshold ?? 1.0;

        // Calibrated default provider / node concurrency limits:
        const defaultLimits: Record<string, number> = {
            groq: 2,             // Free tier TPM / RPM tight limit (1-2 concurrent)
            mistral: 3,          // Free tier moderate concurrency
            github: 4,           // GitHub Models free tier
            openrouter: 4,       // Free tier routing
            gemini: 10,          // Gemini high concurrency limit
            simulated: 50,       // Mock / test
            mock: 50,
            'custom-mock': 50,
            ...(config?.nodeConcurrencyLimits || {})
        };

        for (const [key, limit] of Object.entries(defaultLimits)) {
            this.concurrencyLimits.set(key.toLowerCase(), Math.max(1, limit));
        }
    }

    private normalizeKey(nodeKey: string): string {
        return (nodeKey || '').toLowerCase().trim();
    }

    getMaxConcurrency(nodeKey: string): number {
        const key = this.normalizeKey(nodeKey);
        return this.concurrencyLimits.get(key) ?? this.defaultMaxConcurrency;
    }

    setMaxConcurrency(nodeKey: string, limit: number): void {
        const key = this.normalizeKey(nodeKey);
        this.concurrencyLimits.set(key, Math.max(1, Math.round(limit)));
    }

    getActiveInFlight(nodeKey: string): number {
        const key = this.normalizeKey(nodeKey);
        const slots = this.activeSlots.get(key);
        return slots ? slots.size : 0;
    }

    getCapacityHeadroom(nodeKey: string): number {
        const max = this.getMaxConcurrency(nodeKey);
        const active = this.getActiveInFlight(nodeKey);
        return Math.max(0, max - active);
    }

    getNodeHeadroom(nodeKey: string): number {
        return this.getCapacityHeadroom(nodeKey);
    }

    getUtilizationRatio(nodeKey: string): number {
        const max = this.getMaxConcurrency(nodeKey);
        if (max <= 0) return 1.0;
        const active = this.getActiveInFlight(nodeKey);
        return Math.min(1.0, Math.max(0, active / max));
    }

    isSaturated(nodeKey: string): boolean {
        return this.getUtilizationRatio(nodeKey) >= this.saturationThreshold;
    }

    hasCapacity(nodeKey: string, weight: number = 1): boolean {
        return this.getCapacityHeadroom(nodeKey) >= weight;
    }

    tryAcquireSlot(
        nodeKey: string,
        options?: { weight?: number; metadata?: Record<string, any> }
    ): CapacitySlot | null {
        const key = this.normalizeKey(nodeKey);
        const weight = Math.max(1, options?.weight ?? 1);

        if (!this.hasCapacity(key, weight)) {
            return null;
        }

        let slots = this.activeSlots.get(key);
        if (!slots) {
            slots = new Map();
            this.activeSlots.set(key, slots);
        }

        const slotId = `slot-${key}-${Date.now()}-${crypto.randomUUID()}`;
        let released = false;

        const slot: CapacitySlot = {
            slotId,
            nodeKey: key,
            acquiredAt: Date.now(),
            weight,
            metadata: options?.metadata,
            release: () => {
                if (!released) {
                    released = true;
                    this.releaseSlot(slot);
                }
            }
        };

        slots.set(slotId, slot);
        this.totalAcquiredCount.set(key, (this.totalAcquiredCount.get(key) || 0) + 1);

        return slot;
    }

    releaseSlot(slotOrId: CapacitySlot | string, nodeKey?: string): boolean {
        const slotId = typeof slotOrId === 'string' ? slotOrId : slotOrId.slotId;
        const targetNode = typeof slotOrId === 'string'
            ? (nodeKey ? this.normalizeKey(nodeKey) : undefined)
            : slotOrId.nodeKey;

        if (targetNode) {
            const slots = this.activeSlots.get(targetNode);
            if (slots && slots.has(slotId)) {
                slots.delete(slotId);
                this.totalReleasedCount.set(targetNode, (this.totalReleasedCount.get(targetNode) || 0) + 1);
                return true;
            }
        } else {
            for (const [k, slots] of this.activeSlots.entries()) {
                if (slots.has(slotId)) {
                    slots.delete(slotId);
                    this.totalReleasedCount.set(k, (this.totalReleasedCount.get(k) || 0) + 1);
                    return true;
                }
            }
        }

        return false;
    }

    getNodeMetrics(nodeKey: string): NodeCapacityMetrics {
        const key = this.normalizeKey(nodeKey);
        const max = this.getMaxConcurrency(key);
        const active = this.getActiveInFlight(key);
        const headroom = Math.max(0, max - active);
        const ratio = max > 0 ? active / max : 1.0;

        return {
            nodeKey: key,
            maxConcurrency: max,
            activeInFlight: active,
            availableHeadroom: headroom,
            utilizationRatio: Math.round(ratio * 1000) / 1000,
            utilizationPercent: Math.min(100, Math.round(ratio * 100)),
            isSaturated: ratio >= this.saturationThreshold,
            totalSlotsAcquired: this.totalAcquiredCount.get(key) || 0,
            totalSlotsReleased: this.totalReleasedCount.get(key) || 0
        };
    }

    getAllNodeMetrics(): Record<string, NodeCapacityMetrics> {
        const result: Record<string, NodeCapacityMetrics> = {};
        const allKeys = new Set([
            ...this.concurrencyLimits.keys(),
            ...this.activeSlots.keys(),
            ...this.totalAcquiredCount.keys()
        ]);

        for (const k of allKeys) {
            result[k] = this.getNodeMetrics(k);
        }

        return result;
    }

    reset(): void {
        this.activeSlots.clear();
        this.totalAcquiredCount.clear();
        this.totalReleasedCount.clear();
    }
}

export const globalNodeCapacityManager = new NodeCapacityManager();
