import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryCortex, DeterministicLocalEmbeddingProvider } from './memory.ts';
import { createSwarmServer } from './server/app.ts';

describe('Shared Cortex: Tags, Blended Retrieval, Namespaced Wipes & OriginApp Protection', () => {
    let cortex: MemoryCortex;

    beforeEach(() => {
        MemoryCortex.clearFallbackStore('test_shared_cortex');
        cortex = new MemoryCortex({
            collectionName: 'test_shared_cortex',
            defaultAppId: 'default-app',
            isolatedStore: true,
            embeddingProvider: new DeterministicLocalEmbeddingProvider()
        });
    });

    it('A duelodds odds fact about entity team-a is returned to a fantasy read for team-a at reduced weight', async () => {
        await cortex.store('DuelOdds verified odds: team-a moneyline is -110', {
            originApp: 'duelodds',
            domain: 'odds',
            memoryType: 'fact',
            entityIds: ['team-a'],
            qualityRating: 0.95,
            verified: true
        });

        // Fantasy app reads with domain 'odds' and entity 'team-a'
        const retrieved = await cortex.retrieve('Check odds for team-a', {
            appId: 'fantasy',
            domain: 'odds',
            entityIds: ['team-a']
        });

        expect(retrieved).toHaveLength(1);
        expect(retrieved[0].content).toContain('team-a moneyline');
        expect(retrieved[0].originApp).toBe('duelodds');
        expect(retrieved[0].domain).toBe('odds');
        expect(retrieved[0].memoryType).toBe('fact');
        expect(retrieved[0].entityIds).toContain('team-a');
        expect(retrieved[0].retrievalWeight).toBe(0.45);
        expect(retrieved[0].retrievalScore).toBeCloseTo(retrieved[0].rawSimilarity! * 0.45);
        expect(retrieved[0].retrievalScore).toBeLessThan(retrieved[0].rawSimilarity!);
    });

    it('A duelodds judgment with no shared entity is not returned to fantasy', async () => {
        // Judgment with different entity
        await cortex.store('DuelOdds model pick: team-b will cover spread', {
            originApp: 'duelodds',
            domain: 'odds',
            memoryType: 'judgment',
            entityIds: ['team-b']
        });

        // Judgment with no entity
        await cortex.store('DuelOdds speculative opinion: overall betting volume is rising', {
            originApp: 'duelodds',
            domain: 'odds',
            memoryType: 'judgment',
            entityIds: []
        });

        // Fantasy reads for team-a
        const retrieved = await cortex.retrieve('Betting trends and predictions for team-a', {
            appId: 'fantasy',
            domain: 'odds',
            entityIds: ['team-a']
        });

        expect(retrieved).toHaveLength(0);
    });

    it('A wipe for duelodds does not delete fantasy points', async () => {
        // Store points for duelodds
        await cortex.store('DuelOdds baseline odds: team-a vs team-b', {
            originApp: 'duelodds',
            domain: 'odds',
            memoryType: 'fact',
            entityIds: ['team-a', 'team-b']
        });

        // Store points for fantasy
        await cortex.store('Fantasy projection: player-99 will score 28 points', {
            originApp: 'fantasy',
            domain: 'fantasy',
            memoryType: 'fact',
            entityIds: ['player-99']
        });

        expect(cortex.fallbackCount).toBe(2);

        // Wipe only duelodds
        await cortex.wipeCollection('duelodds');

        // Fantasy points must remain intact
        expect(cortex.fallbackCount).toBe(1);
        const fantasyMemories = await cortex.retrieve('Player-99 projection', {
            appId: 'fantasy',
            domain: 'fantasy',
            entityIds: ['player-99']
        });
        expect(fantasyMemories).toHaveLength(1);
        expect(fantasyMemories[0].content).toContain('player-99');
        expect(fantasyMemories[0].originApp).toBe('fantasy');

        // DuelOdds points must be completely removed
        const dueloddsMemories = await cortex.retrieve('team-a odds', {
            appId: 'duelodds',
            domain: 'odds',
            entityIds: ['team-a']
        });
        expect(dueloddsMemories).toHaveLength(0);
    });

    it('Body appId cannot change originApp on write', async () => {
        const testCortex = new MemoryCortex({
            collectionName: 'test_origin_protection_cortex',
            defaultAppId: 'default-app',
            isolatedStore: true,
            embeddingProvider: new DeterministicLocalEmbeddingProvider()
        });

        const app = createSwarmServer({
            defaultCortex: testCortex,
            defaultSettings: {
                appId: 'server-default',
                agents: [
                    { id: 'manager', role: 'Manager Node', provider: 'simulated', model: 'simulated' },
                    { id: 'a1', role: 'Quant Specialist', provider: 'simulated', model: 'simulated' }
                ]
            }
        });

        const originalEnv = { ...process.env };
        process.env.SWARM_APP_TOKENS = 'duelodds:secret-duelodds-token,fantasy:secret-fantasy-token';
        process.env.SWARM_AUTH_REQUIRED = 'true';

        try {
            // Client authenticated as duelodds, but body attempts to claim appId: 'fantasy'
            const res = await app.request('/api/swarm/analyze', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer secret-duelodds-token'
                },
                body: JSON.stringify({
                    task: 'Fast Analysis: team-a odds assessment',
                    settings: {
                        appId: 'fantasy', // Attacker / client attempts to impersonate writer
                        domain: 'odds'
                    }
                })
            });

            expect(res.status).toBe(200);

            // Verify stored memory in cortex: originApp must be authenticated caller 'duelodds', NOT 'fantasy'
            expect(testCortex.fallbackCount).toBeGreaterThan(0);
            const stored = (testCortex as any).fallbackStore[0];
            expect(stored.payload.originApp).toBe('duelodds');
            expect(stored.payload.appId).toBe('duelodds');
        } finally {
            process.env = originalEnv;
        }
    });

    it('A fact outranks a judgment at the same weight', async () => {
        // Store judgment with high similarity
        await cortex.store('team-a injury report judgment: player might sit out', {
            originApp: 'duelodds',
            domain: 'injury',
            memoryType: 'judgment',
            entityIds: ['team-a'],
            qualityRating: 0.6
        });

        // Store fact with verified ground truth
        await cortex.store('team-a injury report verified fact: player confirmed out', {
            originApp: 'duelodds',
            domain: 'injury',
            memoryType: 'fact',
            entityIds: ['team-a'],
            verified: true,
            qualityRating: 0.95
        });

        const retrieved = await cortex.retrieve('team-a injury status', {
            appId: 'duelodds',
            domain: 'injury',
            entityIds: ['team-a'],
            limit: 2
        });

        expect(retrieved).toHaveLength(2);
        // The fact must outrank the judgment
        expect(retrieved[0].memoryType).toBe('fact');
        expect(retrieved[0].content).toContain('verified fact');
        expect(retrieved[1].memoryType).toBe('judgment');
    });

    it('includeShared=false overrides blend and restricts to same originApp only', async () => {
        await cortex.store('DuelOdds verified odds: team-a moneyline is -110', {
            originApp: 'duelodds',
            domain: 'odds',
            memoryType: 'fact',
            entityIds: ['team-a'],
            verified: true
        });

        // Fantasy reads with includeShared=false
        const retrieved = await cortex.retrieve('Check odds for team-a', {
            appId: 'fantasy',
            domain: 'odds',
            entityIds: ['team-a'],
            includeShared: false
        });

        expect(retrieved).toHaveLength(0);
    });
});
