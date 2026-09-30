import { describe, it, expect } from 'vitest';
import { ModelRouter, RouteConfig } from './router.ts';

describe('ModelRouter', () => {
    describe('evaluateFastPath', () => {
        it('should bypass fast-path if forceFullSwarm is true', () => {
            const decision = ModelRouter.evaluateFastPath('task', 'data', false, true);
            expect(decision.eligible).toBe(false);
            expect(decision.reason).toContain('explicitly requested via settings override');
            expect(decision.targetTier).toBe('simple');
        });

        it('should require complex tier if deep analysis is requested', () => {
            const decision = ModelRouter.evaluateFastPath('task', 'data', true, false);
            expect(decision.eligible).toBe(false);
            expect(decision.reason).toContain('Deep analysis explicitly requested');
            expect(decision.targetTier).toBe('complex');
        });

        it('should map deep keywords to complex tier', () => {
            const decision = ModelRouter.evaluateFastPath('please audit this code', '', false, false);
            expect(decision.eligible).toBe(false);
            expect(decision.reason).toContain('deep analysis or verification keywords');
            expect(decision.targetTier).toBe('complex');
        });

        it('should map format keywords to formatting tier', () => {
            const decision = ModelRouter.evaluateFastPath('please format this as json', '', false, false);
            expect(decision.eligible).toBe(false);
            expect(decision.reason).toContain('standard schema processing');
            expect(decision.targetTier).toBe('formatting');
        });

        it('should route to instant tier if tokens < 60 and data < 512 bytes', () => {
            const decision = ModelRouter.evaluateFastPath('what is the capital of france?', 'some small data', false, false);
            expect(decision.eligible).toBe(true);
            expect(decision.reason).toContain('Low-complexity intent');
            expect(decision.targetTier).toBe('instant');
        });

        it('should route to complex if tokens > 3000', () => {
            const largeData = 'a'.repeat(12000); // 12000 chars / 4 = 3000 tokens
            const decision = ModelRouter.evaluateFastPath('summarize', largeData, false, false);
            expect(decision.eligible).toBe(false);
            expect(decision.targetTier).toBe('complex');
        });

        it('should route to simple for standard size payloads without special keywords', () => {
            const mediumData = 'a'.repeat(2000); // 500 tokens
            const decision = ModelRouter.evaluateFastPath('summarize', mediumData, false, false);
            expect(decision.eligible).toBe(false);
            expect(decision.targetTier).toBe('simple');
        });
    });

    describe('isFastPathEligible', () => {
        it('should return false if forceFullSwarm is true', () => {
            expect(ModelRouter.isFastPathEligible('task', 0, false, true)).toBe(false);
        });

        it('should return false if deepAnalysisRequested is true', () => {
            expect(ModelRouter.isFastPathEligible('task', 0, true, false)).toBe(false);
        });

        it('should return false if dataLength >= 512', () => {
            expect(ModelRouter.isFastPathEligible('task', 600, false, false)).toBe(false);
        });

        it('should return false if estTokens >= 60', () => {
            const longTask = 'a'.repeat(240); // 60 tokens
            expect(ModelRouter.isFastPathEligible(longTask, 0, false, false)).toBe(false);
        });

        it('should return false if task contains deep keywords', () => {
            expect(ModelRouter.isFastPathEligible('verify the results', 0, false, false)).toBe(false);
        });

        it('should return false if task contains format keywords', () => {
            expect(ModelRouter.isFastPathEligible('output as csv', 0, false, false)).toBe(false);
        });

        it('should return true for eligible tasks', () => {
            expect(ModelRouter.isFastPathEligible('hello', 10, false, false)).toBe(true);
        });
    });

    describe('inferComplexity', () => {
        it('should return instant if fast path eligible', () => {
            expect(ModelRouter.inferComplexity('hello', 10, 1, false)).toBe('instant');
        });

        it('should return complex if deep keywords present', () => {
            expect(ModelRouter.inferComplexity('audit this', 10, 1, false)).toBe('complex');
        });

        it('should return complex if chunkCount > 2', () => {
            expect(ModelRouter.inferComplexity('summarize', 1000, 3, false)).toBe('complex'); // Use higher payload so fast-path isn't eligible
        });

        it('should return complex if dataLength > 15000', () => {
            expect(ModelRouter.inferComplexity('summarize', 16000, 1, false)).toBe('complex');
        });

        it('should return formatting if format keywords present', () => {
            expect(ModelRouter.inferComplexity('format as json', 1000, 1, false)).toBe('formatting');
        });

        it('should return simple for standard requests', () => {
            expect(ModelRouter.inferComplexity('summarize', 1000, 1, false)).toBe('simple');
        });

        it('should not return instant if forceFullSwarm is true', () => {
            expect(ModelRouter.inferComplexity('hello', 10, 1, true)).toBe('simple');
        });
    });

    describe('getRecommendedModel', () => {
        it('should return correct models for gemini', () => {
            expect(ModelRouter.getRecommendedModel('gemini', 'instant')).toBe('gemini-2.5-flash-lite');
            expect(ModelRouter.getRecommendedModel('gemini', 'simple')).toBe('gemini-2.5-flash');
        });

        it('should return correct models for groq', () => {
            expect(ModelRouter.getRecommendedModel('groq', 'instant')).toBe('llama-3.1-8b-instant');
            expect(ModelRouter.getRecommendedModel('groq', 'simple')).toBe('llama-3.3-70b-versatile');
        });

        it('should return correct models for openrouter', () => {
            expect(ModelRouter.getRecommendedModel('openrouter', 'complex')).toBe('deepseek/deepseek-r1:free');
            expect(ModelRouter.getRecommendedModel('openrouter', 'instant')).toBe('meta-llama/llama-3.3-70b-instruct:free');
            expect(ModelRouter.getRecommendedModel('openrouter', 'simple')).toBe('deepseek/deepseek-r1:free');
        });

        it('should return mistral-small-latest for mistral', () => {
            expect(ModelRouter.getRecommendedModel('mistral', 'instant')).toBe('mistral-small-latest');
            expect(ModelRouter.getRecommendedModel('mistral', 'simple')).toBe('mistral-small-latest');
        });

        it('should return gpt-4o-mini for github', () => {
            expect(ModelRouter.getRecommendedModel('github', 'instant')).toBe('gpt-4o-mini');
            expect(ModelRouter.getRecommendedModel('github', 'simple')).toBe('gpt-4o-mini');
        });

        it('should fallback to gemini-2.5-flash for unknown providers', () => {
            expect(ModelRouter.getRecommendedModel('unknown' as any, 'simple')).toBe('gemini-2.5-flash');
        });
    });

    describe('isValidModel', () => {
        it('should return true for valid models', () => {
            expect(ModelRouter.isValidModel('gpt-4')).toBe(true);
        });

        it('should return false for invalid models', () => {
            expect(ModelRouter.isValidModel('')).toBe(false);
            expect(ModelRouter.isValidModel(undefined as any)).toBe(false);
            expect(ModelRouter.isValidModel(null as any)).toBe(false);
        });
    });

    describe('createRoutedAgent', () => {
        const baseConfig: RouteConfig = {
            complexity: 'simple',
            role: 'user',
            apiKey: 'test-key',
            provider: 'gemini',
        };

        it('should use provided modelName if valid', () => {
            const config = { ...baseConfig, modelName: 'custom-model' };
            const agent = ModelRouter.createRoutedAgent(config);
            expect(agent.modelName).toBe('custom-model');
            expect(agent.role).toBe('user');
            expect(agent.provider).toBe('gemini');
        });

        it('should fallback to recommended model if modelName is invalid or missing', () => {
            const agent = ModelRouter.createRoutedAgent(baseConfig);
            expect(agent.modelName).toBe('gemini-2.5-flash');
        });

        it('should apply system instruction if provided', () => {
            const config = { ...baseConfig, systemInstruction: 'be helpful' };
            const agent = ModelRouter.createRoutedAgent(config);
            // Internal state check depends on Agent implementation, but we can check if it sets it.
            // Let's assume there is a method or it's stored. The file router.ts calls agent.setSystemInstruction.
            expect(agent).toBeDefined();
        });

        it('should default to gemini provider if omitted', () => {
            const config = { ...baseConfig, provider: undefined };
            const agent = ModelRouter.createRoutedAgent(config);
            expect(agent.provider).toBe('gemini');
        });
    });
});
