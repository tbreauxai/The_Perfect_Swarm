import type { DriftAlert, DriftType } from './types.ts';
export class ConceptDriftDetector {
    // Page-Hinkley parameters for latency
    private latencyMean: number = 0;
    private latencyCount: number = 0;
    private latencyCumulativeDev: number = 0;
    private latencyMinCumulative: number = 0;
    private latencyDelta: number = 5; // tolerance parameter
    private latencyThreshold: number = 60; // detection threshold

    // Page-Hinkley parameters for quality
    private qualityMean: number = 0;
    private qualityCount: number = 0;
    private qualityCumulativeDev: number = 0;
    private qualityMaxCumulative: number = 0;
    private qualityDelta: number = 0.05;
    private qualityThreshold: number = 0.35;

    // Embedding centroid tracking
    private referenceCentroid: number[] | null = null;
    private recentCentroidWindow: number[][] = [];
    private windowCapacity: number = 20;
    private centroidDriftThreshold: number = 0.80; // Cosine similarity drop below this is drift

    private alerts: DriftAlert[] = [];

    public constructor(options?: {
        latencyThreshold?: number;
        qualityThreshold?: number;
        centroidDriftThreshold?: number;
        windowCapacity?: number;
    }) {
        if (options?.latencyThreshold) this.latencyThreshold = options.latencyThreshold;
        if (options?.qualityThreshold) this.qualityThreshold = options.qualityThreshold;
        if (options?.centroidDriftThreshold) this.centroidDriftThreshold = options.centroidDriftThreshold;
        if (options?.windowCapacity) this.windowCapacity = options.windowCapacity;
    }

    /**
     * Page-Hinkley test for upward latency drift.
     */
    public recordLatencyObservation(durationMs: number): DriftAlert | null {
        this.latencyCount++;
        this.latencyMean += (durationMs - this.latencyMean) / this.latencyCount;
        this.latencyCumulativeDev += (durationMs - this.latencyMean - this.latencyDelta);

        if (this.latencyCumulativeDev < this.latencyMinCumulative) {
            this.latencyMinCumulative = this.latencyCumulativeDev;
        }

        const phStatistic = this.latencyCumulativeDev - this.latencyMinCumulative;

        if (phStatistic > this.latencyThreshold) {
            const alert: DriftAlert = {
                id: crypto.randomUUID(),
                driftType: 'page-hinkley-latency',
                severity: phStatistic > this.latencyThreshold * 1.5 ? 'critical' : 'warning',
                metric: 'durationMs',
                currentValue: durationMs,
                baselineValue: Math.round(this.latencyMean),
                threshold: this.latencyThreshold,
                recommendedAction: 'tighten-thresholds',
                timestamp: Date.now(),
                message: `Latency concept drift detected: PH-statistic ${Math.round(phStatistic)} exceeded threshold ${this.latencyThreshold}`
            };
            this.alerts.push(alert);
            // Reset sequential detector
            this.latencyCumulativeDev = 0;
            this.latencyMinCumulative = 0;
            return alert;
        }
        return null;
    }

    /**
     * Page-Hinkley test for downward quality drift.
     */
    public recordQualityObservation(qualityScore: number): DriftAlert | null {
        this.qualityCount++;
        this.qualityMean += (qualityScore - this.qualityMean) / this.qualityCount;
        // Tracking downward drop
        this.qualityCumulativeDev += (this.qualityMean - qualityScore - this.qualityDelta);

        if (this.qualityCumulativeDev < this.qualityMaxCumulative) {
            this.qualityMaxCumulative = this.qualityCumulativeDev;
        }

        const phStatistic = this.qualityCumulativeDev - this.qualityMaxCumulative;

        if (phStatistic > this.qualityThreshold) {
            const alert: DriftAlert = {
                id: crypto.randomUUID(),
                driftType: 'page-hinkley-quality',
                severity: phStatistic > this.qualityThreshold * 1.5 ? 'critical' : 'warning',
                metric: 'qualityScore',
                currentValue: Math.round(qualityScore * 100) / 100,
                baselineValue: Math.round(this.qualityMean * 100) / 100,
                threshold: this.qualityThreshold,
                recommendedAction: 'reset-policy',
                timestamp: Date.now(),
                message: `Quality degradation drift detected: PH-statistic ${Math.round(phStatistic * 100) / 100} exceeded threshold ${this.qualityThreshold}`
            };
            this.alerts.push(alert);
            this.qualityCumulativeDev = 0;
            this.qualityMaxCumulative = 0;
            return alert;
        }
        return null;
    }

    /**
     * Records embedding and evaluates vector divergence from reference centroid.
     */
    public recordEmbeddingObservation(vector: number[]): DriftAlert | null {
        if (!vector || vector.length === 0) return null;

        if (!this.referenceCentroid) {
            this.referenceCentroid = [...vector];
            return null;
        }

        this.recentCentroidWindow.push(vector);
        if (this.recentCentroidWindow.length > this.windowCapacity) {
            this.recentCentroidWindow.shift();
        }

        if (this.recentCentroidWindow.length >= 5) {
            const currentCentroid = this.calculateCentroid(this.recentCentroidWindow);
            const sim = this.cosineSimilarity(this.referenceCentroid, currentCentroid);

            if (sim < this.centroidDriftThreshold) {
                const alert: DriftAlert = {
                    id: crypto.randomUUID(),
                    driftType: 'embedding-centroid-shift',
                    severity: sim < this.centroidDriftThreshold - 0.15 ? 'critical' : 'warning',
                    metric: 'centroidCosineSimilarity',
                    currentValue: Math.round(sim * 1000) / 1000,
                    baselineValue: 1.0,
                    threshold: this.centroidDriftThreshold,
                    recommendedAction: 're-index-memory',
                    timestamp: Date.now(),
                    message: `Semantic concept drift detected: Centroid similarity ${Math.round(sim * 1000) / 1000} fell below ${this.centroidDriftThreshold}`
                };
                this.alerts.push(alert);
                // Update reference centroid to absorb new regime
                this.referenceCentroid = currentCentroid;
                return alert;
            }
        }
        return null;
    }

    /**
     * Validates incoming data payload for structural soundness and anomaly limits.
     */
    public validateDataPayload(data: any): { valid: boolean; issues: string[] } {
        const issues: string[] = [];

        if (data === undefined || data === null) {
            issues.push('Payload is null or undefined');
            return { valid: false, issues };
        }

        if (typeof data === 'string') {
            if (data.trim().length === 0) {
                issues.push('Payload string is empty');
            } else if (data.length > 2_000_000) {
                issues.push(`Payload length (${data.length} chars) exceeds maximum safety limit`);
            }
        } else if (typeof data === 'object') {
            const keys = Object.keys(data);
            if (keys.length === 0 && !Array.isArray(data)) {
                issues.push('Payload object is empty');
            }
        }

        return {
            valid: issues.length === 0,
            issues
        };
    }

    private calculateCentroid(vectors: number[][]): number[] {
        const dim = vectors[0].length;
        const centroid = new Array(dim).fill(0);
        for (const v of vectors) {
            for (let d = 0; d < dim; d++) {
                centroid[d] += (v[d] || 0) / vectors.length;
            }
        }
        return centroid;
    }

    private cosineSimilarity(vecA: number[], vecB: number[]): number {
        let dot = 0;
        let normA = 0;
        let normB = 0;
        for (let i = 0; i < vecA.length; i++) {
            const a = vecA[i] || 0;
            const b = vecB[i] || 0;
            dot += a * b;
            normA += a * a;
            normB += b * b;
        }
        if (normA === 0 || normB === 0) return 0;
        return dot / (Math.sqrt(normA) * Math.sqrt(normB));
    }

    public getAlerts(): DriftAlert[] {
        return [...this.alerts];
    }

    public clearAlerts(): void {
        this.alerts = [];
    }

    public reset(): void {
        this.latencyMean = 0;
        this.latencyCount = 0;
        this.latencyCumulativeDev = 0;
        this.latencyMinCumulative = 0;
        this.qualityMean = 0;
        this.qualityCount = 0;
        this.qualityCumulativeDev = 0;
        this.qualityMaxCumulative = 0;
        this.referenceCentroid = null;
        this.recentCentroidWindow = [];
        this.alerts = [];
    }
}
