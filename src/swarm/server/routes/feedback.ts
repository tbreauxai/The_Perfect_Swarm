import type { Hono } from 'hono';
import { globalFeedbackEngine, analystLedger } from '../../feedback.ts';
import { globalSpecialistProfiler } from '../../loadBalancer.ts';
import {
    outcomeToScore,
    recordProbabilityObservation,
    fitCalibration,
    observationsForApp
} from '../../feedback/probabilityCalibration.ts';
import {
    generateDedupeKey,
    isFeedbackInFlight,
    setFeedbackInFlight,
    removeFeedbackInFlight,
    isFeedbackProcessed,
    markFeedbackProcessed
} from '../feedbackDedupe.ts';
import type { ServerRouteContext } from './types.ts';
import { handleServerError } from './helpers.ts';

export function registerFeedbackRoutes(app: Hono, ctx: ServerRouteContext): void {
    const { defaultCortex } = ctx;

    app.post('/api/swarm/feedback', async (c) => {
        const callerAppId = (c as any).get('callerAppId') as string | undefined;
        let dedupKey: string | undefined = undefined;

        try {
            const body = await c.req.json().catch(() => ({}));
            const { workflowId, outcome, gradedAt, predictedProbability, sportKey, market } = body;

            if (!workflowId || !['win', 'loss', 'push'].includes(outcome)) {
                return c.json({ error: 'Invalid workflowId or outcome' }, 400);
            }

            if (!callerAppId) {
                return c.json({ error: 'Unauthorized: missing callerAppId' }, 401);
            }
            const originApp = callerAppId;
            const pickId = body.pickId || body.pick_id;

            dedupKey = generateDedupeKey(callerAppId, workflowId, pickId, outcome, body);

            if (isFeedbackInFlight(dedupKey)) {
                return c.json({ error: 'Conflict: Feedback processing in progress, retry later' }, 409);
            }

            if (await isFeedbackProcessed(dedupKey)) {
                return c.json({ ok: true, duplicate: true, message: 'Feedback already processed', workflowId, pickId }, 200);
            }

            setFeedbackInFlight(dedupKey);

            // 1. Grade the point in MemoryCortex
            let gradeResult = { found: false, alreadyProcessed: false };
            if (defaultCortex) {
                gradeResult = await defaultCortex.gradeMemoryByWorkflowId({
                    workflowId,
                    originApp,
                    outcome,
                    gradedAt
                });
            }

            if (!gradeResult.found) {
                return c.json({ error: 'Workflow not found' }, 404);
            }

            // 2. Query in-memory knowledge repository (scoped to originApp, without defaulting missing appId to perfect-swarm)
            const allWorkflowRecords = globalFeedbackEngine.getKnowledgeRepository().queryOutcomes().filter((o: any) => o.workflowId === workflowId);
            const workflowRecords = allWorkflowRecords.filter((o: any) => {
                const recordApp = o.appId || o.originApp;
                return Boolean(recordApp && recordApp === originApp);
            });

            // 3. Handle idempotency
            if (gradeResult.alreadyProcessed || workflowRecords.some((o: any) => o.feedbackProcessed)) {
                return c.json({ ok: true, duplicate: true, message: 'Feedback already processed', workflowId, alreadyProcessed: true });
            }

            const accuracyScore = outcome === 'win' ? 1.0 : outcome === 'loss' ? 0.0 : 0.5;
            const score = outcomeToScore(outcome);
            const statedProbability = Number(predictedProbability);
            if (score != null && Number.isFinite(statedProbability) && statedProbability > 0 && statedProbability < 1) {
                recordProbabilityObservation({
                    workflowId,
                    appId: originApp,
                    predictedProbability: statedProbability,
                    outcome: score,
                    sportKey: typeof sportKey === 'string' ? sportKey : undefined,
                    market: typeof market === 'string' ? market : undefined,
                    gradedAt: typeof gradedAt === 'string' ? gradedAt : new Date().toISOString()
                });
            }

            // 4. Update in-memory feedback engine & profiler if workflow record exists
            let compositeReward: number | undefined = undefined;
            let components: any = undefined;

            if (workflowRecords.length > 0) {
                const workflowRecord = workflowRecords[0];

                compositeReward = accuracyScore;
                components = { accuracyReward: accuracyScore };

                const roles = ((workflowRecord as any).agentRoles || []).filter(Boolean);
                for (const role of roles) {
                    analystLedger.recordOutcome(originApp, role, outcome);
                    globalSpecialistProfiler.recordAccuracy(role, outcome);
                }

                for (const r of workflowRecords) {
                    (r as any).feedbackProcessed = true;
                    (r as any).gradedAt = gradedAt || Date.now();
                    if (!(r as any).metrics) {
                        (r as any).metrics = {};
                    }
                    (r as any).metrics.accuracyScore = accuracyScore;
                    (r as any).outcome = outcome;
                    if (Number.isFinite(statedProbability)) (r as any).predictedProbability = statedProbability;
                    if (sportKey) (r as any).sportKey = sportKey;
                    if (market) (r as any).market = market;
                    globalFeedbackEngine.getKnowledgeRepository().persistOutcome(r as any);
                }
            }

            markFeedbackProcessed(dedupKey);

            return c.json({
                ok: true,
                workflowId,
                outcome,
                accuracyScore,
                compositeReward: compositeReward ?? accuracyScore,
                components: components ?? { accuracyReward: accuracyScore },
                calibration: fitCalibration(observationsForApp(originApp))
            });
        } catch (err: any) {
            return handleServerError('Feedback', err, c);
        } finally {
            if (dedupKey) {
                removeFeedbackInFlight(dedupKey);
            }
        }
    });

    app.post('/api/swarm/calibrate', async (c) => {
        try {
            const body = await c.req.json().catch(() => ({}));
            const { appId, observations, iterations = 400, autoApply = true, minSamples = 2 } = body;

            let result;
            if (Array.isArray(observations) && observations.length > 0) {
                result = globalFeedbackEngine.calibrateRewardWeights(observations, { iterations, autoApply });
            } else {
                result = globalFeedbackEngine.calibrateFromKnowledgeRepository({ appId, minSamples, iterations, autoApply });
                if (!result) {
                    return c.json({
                        ok: false,
                        error: `Insufficient graded samples in knowledge repository (minimum required: ${minSamples})`,
                        currentWeights: globalFeedbackEngine.getRewardWeights()
                    }, 400);
                }
            }

            return c.json({
                ok: true,
                ...result,
                currentWeights: globalFeedbackEngine.getRewardWeights()
            });
        } catch (err: any) {
            return handleServerError('Calibrate', err, c);
        }
    });

    app.get('/api/swarm/calibrate', (c) => {
        const appId = c.req.query('appId');
        const allOutcomes = globalFeedbackEngine.getKnowledgeRepository().queryOutcomes({ appId, limit: 1000 });
        const gradedCount = allOutcomes.filter((o: any) => o.feedbackProcessed).length;
        return c.json({
            currentWeights: globalFeedbackEngine.getRewardWeights(),
            totalGradedOutcomes: gradedCount
        });
    });
}
