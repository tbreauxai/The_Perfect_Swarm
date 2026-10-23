import type { Hono } from 'hono';
import { DEFAULT_PROVIDER_MODELS } from '../../agent.ts';
import { globalPayloadCache, globalSemanticCache } from '../../cache.ts';
import { globalTieredCache } from '../../tieredCache.ts';
import { globalActionPlanCache } from '../../actionPlanCache.ts';
import { globalTelemetryCollector } from '../../telemetry.ts';
import { analystLedger } from '../../feedback.ts';
import { globalSpecialistProfiler } from '../../loadBalancer.ts';
import { buildCortexDiagnostics } from '../cortexDiagnostics.ts';
import { fetchProviderModels } from '../modelsProvider.ts';
import type { ServerRouteContext } from './types.ts';
import { resolveEnvironment, handleServerError } from './helpers.ts';

export function registerModelsRoutes(app: Hono, ctx: ServerRouteContext): void {
    const { defaultCortex } = ctx;

    app.get('/api/swarm/models', async (c) => {
        try {
            const provider = c.req.query('provider');
            if (!provider) {
                return c.json({ error: 'Missing required query parameter: provider' }, 400);
            }

            const env = resolveEnvironment(c);
            // Model listing uses server secrets only; ignore x-provider-key
            const models = await fetchProviderModels(provider, undefined, env, { boundedWaitMs: 8000 });
            return c.json(models);
        } catch (err: any) {
            return handleServerError('Models', err, c);
        }
    });

    app.get('/api/swarm/config', (c) => {
        return c.json({ defaultModels: DEFAULT_PROVIDER_MODELS });
    });

    app.get('/api/swarm/metrics', (c) => {
        const payloadStats = globalPayloadCache.getStats();
        const semanticStats = globalSemanticCache.getStats();
        const tieredMetrics = globalTieredCache.getMetrics();
        const actionPlanStats = globalActionPlanCache.getStats();

        const totalHits = payloadStats.hits + semanticStats.hits + tieredMetrics.l1Hits + tieredMetrics.l2Hits + tieredMetrics.l3Hits + actionPlanStats.hits;
        const totalMisses = payloadStats.misses + semanticStats.misses + tieredMetrics.misses + actionPlanStats.misses;
        globalTelemetryCollector.syncCacheMetrics(totalHits, totalMisses);

        const snapshot = globalTelemetryCollector.getSnapshot();
        return c.json({
            ...snapshot,
            analystAccuracy: analystLedger.getMetrics(),
            specialistProfiles: globalSpecialistProfiler.getAllProfiles()
        });
    });

    app.get('/api/swarm/cortex/diagnostics', async (c) => {
        try {
            const appId = c.req.query('appId');
            const cortex = defaultCortex;
            if (!cortex) {
                return c.json({ error: 'Cortex not initialized' }, 503);
            }
            const diagnostics = await buildCortexDiagnostics(cortex, appId);
            return c.json(diagnostics);
        } catch (err: any) {
            return handleServerError('Cortex Diagnostics', err, c);
        }
    });
}
