import type { PerformanceAnomaly } from './types.ts';

export class PerformanceAnomalyDetector {
    private baselineP95: number = 0;
    private baselineP99: number = 0;
    private observedLatencies: number[] = [];

    calibrate(latencies: number[]): void {
        if (!latencies || latencies.length === 0) return;
        this.observedLatencies = [...latencies].sort((a, b) => a - b);
        const count = this.observedLatencies.length;
        const p95Idx = Math.min(count - 1, Math.max(0, Math.ceil(0.95 * count) - 1));
        const p99Idx = Math.min(count - 1, Math.max(0, Math.ceil(0.99 * count) - 1));
        this.baselineP95 = this.observedLatencies[p95Idx];
        this.baselineP99 = this.observedLatencies[p99Idx];
    }

    checkLatency(subsystem: string, observedMs: number): PerformanceAnomaly | null {
        if (this.baselineP99 > 0 && observedMs > this.baselineP99 * 2.0) {
            return {
                id: crypto.randomUUID(),
                subsystem,
                metric: 'latencyMs',
                observedValue: observedMs,
                baselineValue: this.baselineP99,
                threshold: this.baselineP99 * 2.0,
                severity: 'critical',
                message: `Critical latency spike: ${observedMs}ms exceeded baseline p99 (${this.baselineP99}ms) by >200%`,
                timestamp: Date.now()
            };
        }
        if (this.baselineP95 > 0 && observedMs > this.baselineP95 * 1.5) {
            return {
                id: crypto.randomUUID(),
                subsystem,
                metric: 'latencyMs',
                observedValue: observedMs,
                baselineValue: this.baselineP95,
                threshold: this.baselineP95 * 1.5,
                severity: 'warning',
                message: `Elevated latency warning: ${observedMs}ms exceeded baseline p95 (${this.baselineP95}ms) by >150%`,
                timestamp: Date.now()
            };
        }
        return null;
    }

    getBaselines(): { p95: number; p99: number; sampleCount: number } {
        return {
            p95: this.baselineP95,
            p99: this.baselineP99,
            sampleCount: this.observedLatencies.length
        };
    }
}
