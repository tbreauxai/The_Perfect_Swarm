import { describe, it, expect, beforeEach } from 'vitest';
import { createTelemetryMiddleware, TelemetryMetricsCollector } from './telemetry';

describe('TelemetryMetricsCollector & Middleware', () => {
    let collector: TelemetryMetricsCollector;

    beforeEach(() => {
        collector = TelemetryMetricsCollector.getInstance();
        collector.reset();
    });

    it('records 200 responses as success', async () => {
        const middleware = createTelemetryMiddleware(collector);
        const mockContext = {
            req: { path: '/api/swarm/analyze' },
            res: { status: 200 }
        };

        await middleware(mockContext, async () => {});

        const snapshot = collector.getSnapshot();
        expect(snapshot.totalRequests).toBe(1);
        expect(snapshot.successCount).toBe(1);
        expect(snapshot.failureCount).toBe(0);
        expect(snapshot.errorRate).toBe(0);
    });

    it('records non-2xx responses (400, 404, 500) as failures', async () => {
        const middleware = createTelemetryMiddleware(collector);

        // Test 400 Bad Request
        const ctx400 = { req: { path: '/api/swarm/analyze' }, res: { status: 400 } };
        await middleware(ctx400, async () => {});

        // Test 500 Server Error
        const ctx500 = { req: { path: '/api/swarm/analyze' }, res: { status: 500 } };
        await middleware(ctx500, async () => {});

        // Test 302 Redirect
        const ctx302 = { req: { path: '/api/swarm/redirect' }, res: { status: 302 } };
        await middleware(ctx302, async () => {});

        const snapshot = collector.getSnapshot();
        expect(snapshot.totalRequests).toBe(3);
        expect(snapshot.successCount).toBe(0);
        expect(snapshot.failureCount).toBe(3);
        expect(snapshot.errorRate).toBe(1);
    });

    it('records unhandled exceptions as failures', async () => {
        const middleware = createTelemetryMiddleware(collector);
        const mockContext = {
            req: { path: '/api/swarm/analyze' }
        };

        await expect(
            middleware(mockContext, async () => {
                throw new Error('Database connection failed');
            })
        ).rejects.toThrow('Database connection failed');

        const snapshot = collector.getSnapshot();
        expect(snapshot.totalRequests).toBe(1);
        expect(snapshot.successCount).toBe(0);
        expect(snapshot.failureCount).toBe(1);
        expect(snapshot.errorRate).toBe(1);
    });
});
