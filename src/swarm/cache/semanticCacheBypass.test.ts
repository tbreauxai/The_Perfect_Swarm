import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    globalSemanticCache,
    isSemanticCacheEnabled,
} from '../cache.ts';
import {
    checkSemanticCacheMatch,
    resolveEarlyCacheHit,
} from '../engine/cachingPipeline.ts';
import { SwarmContext } from '../context.ts';

describe('Semantic cache disable (SEMANTIC_CACHE_ENABLED) & per-request bypass', () => {
    const origEnv = process.env.SEMANTIC_CACHE_ENABLED;

    beforeEach(() => {
        globalSemanticCache.clear();
        delete process.env.SEMANTIC_CACHE_ENABLED;
    });

    afterEach(() => {
        if (origEnv === undefined) {
            delete process.env.SEMANTIC_CACHE_ENABLED;
        } else {
            process.env.SEMANTIC_CACHE_ENABLED = origEnv;
        }
        globalSemanticCache.clear();
    });

    it('defaults SEMANTIC_CACHE_ENABLED to true and disables on false/0', () => {
        expect(isSemanticCacheEnabled()).toBe(true);
        process.env.SEMANTIC_CACHE_ENABLED = 'false';
        expect(isSemanticCacheEnabled()).toBe(false);
        process.env.SEMANTIC_CACHE_ENABLED = '0';
        expect(isSemanticCacheEnabled()).toBe(false);
        process.env.SEMANTIC_CACHE_ENABLED = 'true';
        expect(isSemanticCacheEnabled()).toBe(true);
    });

    it('skips semantic cache lookup when SEMANTIC_CACHE_ENABLED=false', () => {
        globalSemanticCache.set(
            'best 3-leg parlay today.',
            { analysis: 'Cached parlay' },
            { data: 'board-1', configVersion: 'v1' },
        );

        expect(
            checkSemanticCacheMatch({
                task: 'best 3-leg parlay today.',
                data: 'board-1',
                configVersion: 'v1',
            }).hit,
        ).toBe(true);

        process.env.SEMANTIC_CACHE_ENABLED = 'false';
        const res = checkSemanticCacheMatch({
            task: 'best 3-leg parlay today.',
            data: 'board-1',
            configVersion: 'v1',
        });
        expect(res).toEqual({ hit: false, similarity: 0 });
    });

    it('resolveEarlyCacheHit returns null when bypassCache=true or SEMANTIC_CACHE_ENABLED=false', async () => {
        globalSemanticCache.set(
            'best 3-leg parlay today.',
            { analysis: 'Cached parlay' },
            { data: 'board-1', configVersion: 'v1' },
        );

        const baseParams = {
            task: 'injury report for Knicks only',
            data: 'board-1',
            cacheKey: 'key-2',
            cacheQuery: 'injury report for Knicks only\nboard-1',
            agentConfigVersion: 'v1',
            tieredCacheEnabled: false,
            forceFullSwarm: false,
            bypassCache: true,
            workflowStartTime: Date.now(),
            targetAppId: 'duelodds',
            context: new SwarmContext(),
            params: { task: 'injury report for Knicks only', data: 'board-1' } as any,
        };

        const bypassed = await resolveEarlyCacheHit(baseParams);
        expect(bypassed).toBeNull();

        process.env.SEMANTIC_CACHE_ENABLED = 'false';
        const disabled = await resolveEarlyCacheHit({
            ...baseParams,
            task: 'best 3-leg parlay today.',
            bypassCache: false,
        });
        expect(disabled).toBeNull();
    });
});
