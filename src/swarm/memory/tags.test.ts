import { describe, it, expect } from 'vitest';
import {
    normalizeDomain,
    normalizeMemoryType,
    extractEntityIds,
    normalizeMemoryPayload,
    computeBlendWeight,
    rankAndFilterCandidates
} from './tags.ts';

describe('Memory Tag Utilities', () => {
    it('normalizes domains with fallback to general', () => {
        expect(normalizeDomain('ODDS')).toBe('odds');
        expect(normalizeDomain('injury')).toBe('injury');
        expect(normalizeDomain('Lineup')).toBe('lineup');
        expect(normalizeDomain('fantasy')).toBe('fantasy');
        expect(normalizeDomain('general')).toBe('general');
        expect(normalizeDomain(undefined)).toBe('general');
        expect(normalizeDomain('unknown-domain')).toBe('unknown-domain');
        expect(normalizeDomain(undefined, 'Find betting odds for game')).toBe('odds');
    });

    it('normalizes memoryType into fact or judgment', () => {
        expect(normalizeMemoryType('fact')).toBe('fact');
        expect(normalizeMemoryType('judgment')).toBe('judgment');
        expect(normalizeMemoryType(undefined, { verified: true })).toBe('fact');
        expect(normalizeMemoryType(undefined, { graded: true })).toBe('fact');
        expect(normalizeMemoryType(undefined, { qualityRating: 0.9 })).toBe('fact');
        expect(normalizeMemoryType(undefined, { fastPath: true })).toBe('judgment');
        expect(normalizeMemoryType(undefined, {})).toBe('judgment');
    });

    it('extracts entityIds from explicit arrays and text', () => {
        expect(extractEntityIds('Check team-a vs team-b')).toEqual(['team-a', 'team-b']);
        expect(extractEntityIds('Game info for player-123')).toEqual(['player-123']);
        expect(extractEntityIds(undefined, ['Team-A', 'player-X'])).toEqual(['team-a', 'player-x']);
        expect(extractEntityIds('No entities here')).toEqual([]);
    });

    it('normalizes legacy payloads with missing tags to requirement 4 specs', () => {
        const legacyPoint = {
            appId: 'legacy-app',
            content: 'Old memory note'
        };
        const normalized = normalizeMemoryPayload(legacyPoint);
        expect(normalized.originApp).toBe('legacy-app');
        expect(normalized.appId).toBe('legacy-app');
        expect(normalized.domain).toBe('general');
        expect(normalized.memoryType).toBe('judgment');
        expect(normalized.entityIds).toEqual([]);
    });

    it('computes blend weights according to requirement 2', () => {
        // Same originApp and same domain -> weight 1.0
        const sameAppPoint = normalizeMemoryPayload({ originApp: 'duelodds', domain: 'odds', memoryType: 'judgment' });
        expect(computeBlendWeight(sameAppPoint, 'duelodds', 'odds', [])).toBe(1.0);

        // Different originApp, same domain, shared entityId -> weight 0.45
        const crossAppPoint = normalizeMemoryPayload({ originApp: 'duelodds', domain: 'odds', memoryType: 'fact', entityIds: ['team-a'] });
        expect(computeBlendWeight(crossAppPoint, 'fantasy', 'odds', ['team-a'])).toBe(0.45);

        // Different originApp, same domain, NO shared entityId -> weight 0
        expect(computeBlendWeight(crossAppPoint, 'fantasy', 'odds', ['team-b'])).toBe(0);

        // Different domain -> weight 0
        expect(computeBlendWeight(crossAppPoint, 'fantasy', 'fantasy', ['team-a'])).toBe(0);

        // includeShared=false -> weight 0 for different originApp even with shared entity
        expect(computeBlendWeight(crossAppPoint, 'fantasy', 'odds', ['team-a'], false)).toBe(0);
    });

    it('ranks facts over judgments at same weight and respects weighted vector score', () => {
        const candidates = [
            {
                id: 'c1',
                payload: { originApp: 'duelodds', domain: 'odds', memoryType: 'judgment', content: 'Judgment 1' },
                vectorScore: 0.95
            },
            {
                id: 'c2',
                payload: { originApp: 'duelodds', domain: 'odds', memoryType: 'fact', content: 'Fact 1' },
                vectorScore: 0.85
            }
        ];

        // Same app ('duelodds'), same domain ('odds') -> both have weight 1.0
        // c2 (fact, score 0.85) outranks c1 (judgment, score 0.95) because fact outranks judgment at same weight
        const ranked = rankAndFilterCandidates(candidates, { appId: 'duelodds', domain: 'odds' }, 'query');
        expect(ranked).toHaveLength(2);
        expect(ranked[0].content).toBe('Fact 1');
        expect(ranked[1].content).toBe('Judgment 1');
        expect(ranked[0].retrievalWeight).toBe(1.0);
    });
});
