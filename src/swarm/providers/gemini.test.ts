import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GeminiAdapter } from './gemini.ts';

describe('GeminiAdapter', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('passes responseMimeType: application/json in config when requested', async () => {
        const generateContentMock = vi.fn().mockResolvedValue({
            text: '{"result":"ok"}',
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 }
        });

        const mockClient: any = {
            models: { generateContent: generateContentMock }
        };

        const adapter = new GeminiAdapter();
        const result = await adapter.call({
            modelName: 'gemini-2.5-flash',
            prompt: 'Test prompt',
            apiKey: 'fake-key',
            aiClient: mockClient,
            config: { responseMimeType: 'application/json' }
        });

        expect(generateContentMock).toHaveBeenCalledTimes(1);
        expect(generateContentMock.mock.calls[0][0].config.responseMimeType).toBe('application/json');
        expect(result).toBe('{"result":"ok"}');
    });

    it('retries without responseMimeType if model throws 400/INVALID_ARGUMENT on format', async () => {
        let callCount = 0;
        const capturedConfigs: any[] = [];

        const generateContentMock = vi.fn().mockImplementation(async (params: any) => {
            callCount++;
            capturedConfigs.push({ ...params.config });
            if (callCount === 1) {
                const err: any = new Error('INVALID_ARGUMENT: responseMimeType not supported for this model');
                err.status = 400;
                throw err;
            }
            return {
                text: '{"fallback":"repaired_gemini"}',
                usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 }
            };
        });

        const mockClient: any = {
            models: { generateContent: generateContentMock }
        };

        const adapter = new GeminiAdapter();
        const result = await adapter.call({
            modelName: 'gemini-2.5-flash',
            prompt: 'Test prompt',
            apiKey: 'fake-key',
            aiClient: mockClient,
            config: { responseMimeType: 'application/json' }
        });

        expect(callCount).toBe(2);
        expect(capturedConfigs[0].responseMimeType).toBe('application/json');
        expect(capturedConfigs[1].responseMimeType).toBeUndefined();
        expect(result).toBe('{"fallback":"repaired_gemini"}');
    });

    it('throws error when client cannot be initialized', async () => {
        const adapter = new GeminiAdapter();
        await expect(adapter.call({
            modelName: 'gemini-2.5-flash',
            prompt: 'Test prompt',
            apiKey: ''
        })).rejects.toThrow('Gemini API client could not be initialized.');
    });

    it('formats 429 quota error with [RATE_LIMIT_429]', async () => {
        const generateContentMock = vi.fn().mockRejectedValue({
            status: 429,
            message: 'RESOURCE_EXHAUSTED: quota exceeded'
        });

        const mockClient: any = {
            models: { generateContent: generateContentMock }
        };

        const adapter = new GeminiAdapter();
        await expect(adapter.call({
            modelName: 'gemini-2.5-flash',
            prompt: 'Test prompt',
            apiKey: 'fake-key',
            aiClient: mockClient
        })).rejects.toThrow(/\[RATE_LIMIT_429\] Gemini quota\/rate limit exceeded/);
    });
});
