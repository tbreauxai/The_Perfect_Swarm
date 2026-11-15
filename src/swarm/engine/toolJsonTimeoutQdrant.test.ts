import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { executeOpenAiCompatibleChat } from '../providers/baseOpenAi.ts';
import { GitHubAdapter } from '../providers/github.ts';
import { GeminiAdapter } from '../providers/gemini.ts';
import { runSeatWithTools, PROVIDER_CALL_DEADLINES, SEAT_DEADLINE_MS } from './seatToolLoop.ts';
import { handleSwarmSse } from '../server/streaming.ts';
import { QdrantStorageAdapter, toValidQdrantId } from '../memory/storage/qdrantStorage.ts';
import { MemoryCortex } from '../memory/cortex.ts';
import { ToolRegistry } from '../tools/registry.ts';

describe('Tool & JSON Mode Guards (Clause a)', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('baseOpenAi does not include response_format when tools are present', async () => {
    let capturedBody: any = null;
    globalThis.fetch = vi.fn(async (_url, init: any) => {
      capturedBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }));
    });

    await executeOpenAiCompatibleChat(
      {
        provider: 'groq',
        modelName: 'llama-3.3-70b-versatile',
        prompt: 'test',
        config: {
          tools: [{ type: 'function', function: { name: 'get_matchup' } }]
        }
      },
      {
        providerName: 'groq',
        endpoint: 'https://api.groq.com/openai/v1/chat/completions',
        apiKey: 'gsk_test',
        modelName: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: 'test' }],
        maxTokens: 500,
        isJson: true,
        timeoutMs: 5000
      }
    );

    expect(capturedBody).toBeDefined();
    expect(capturedBody.response_format).toBeUndefined();
    expect(capturedBody.tools).toHaveLength(1);
  });

  it('baseOpenAi includes response_format when tools are empty', async () => {
    let capturedBody: any = null;
    globalThis.fetch = vi.fn(async (_url, init: any) => {
      capturedBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }));
    });

    await executeOpenAiCompatibleChat(
      {
        provider: 'groq',
        modelName: 'llama-3.3-70b-versatile',
        prompt: 'test',
        config: { tools: [] }
      },
      {
        providerName: 'groq',
        endpoint: 'https://api.groq.com/openai/v1/chat/completions',
        apiKey: 'gsk_test',
        modelName: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: 'test' }],
        maxTokens: 500,
        isJson: true,
        timeoutMs: 5000
      }
    );

    expect(capturedBody).toBeDefined();
    expect(capturedBody.response_format).toEqual({ type: 'json_object' });
  });

  it('GitHubAdapter omits response_format when tools are present', async () => {
    let capturedBody: any = null;
    globalThis.fetch = vi.fn(async (_url, init: any) => {
      capturedBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }));
    });

    const { setGithubModelsRetiredForTest } = await import('../providers/github.ts');
    setGithubModelsRetiredForTest(false);

    try {
      const adapter = new GitHubAdapter();
      await adapter.call({
        provider: 'github',
        modelName: 'gpt-4o',
        apiKey: 'ghp_mock_token_12345',
        prompt: 'test',
        config: {
          responseMimeType: 'application/json',
          tools: [{ type: 'function', function: { name: 'calc' } }]
        }
      });

      expect(capturedBody).toBeDefined();
      expect(capturedBody.response_format).toBeUndefined();
      expect(capturedBody.tools).toHaveLength(1);
    } finally {
      setGithubModelsRetiredForTest(true);
    }
  });

  it('GeminiAdapter strips tools and responseMimeType when tools are present', async () => {
    let capturedConfig: any = null;
    const mockGenerateContent = vi.fn(async (params: any) => {
      capturedConfig = params.config;
      return { text: () => '{"ok":true}' };
    });

    const mockAiClient = {
      models: {
        generateContent: mockGenerateContent
      }
    };

    const adapter = new GeminiAdapter();
    await adapter.call({
      provider: 'gemini',
      modelName: 'gemini-2.5-flash',
      apiKey: 'AIzaSy_mock_key',
      aiClient: mockAiClient as any,
      prompt: 'test',
      config: {
        responseMimeType: 'application/json',
        tools: [{ type: 'function', function: { name: 'tool1' } }]
      }
    });

    expect(capturedConfig).toBeDefined();
    expect(capturedConfig.responseMimeType).toBeUndefined();
    expect(capturedConfig.responseSchema).toBeUndefined();
    expect(capturedConfig.tools).toBeUndefined();
  });
});

describe('Deadlines & Hanging LLM Call / SSE Run Timeout (Clause b)', () => {
  it('seatToolLoop wraps runAgent in deadline and fails fast when hanging', async () => {
    const hangingAgent = {
      provider: 'groq',
      modelName: 'llama-3.3-70b-versatile',
      run: vi.fn(() => new Promise((_resolve) => {
        // never resolves
      }))
    };

    const registry = new ToolRegistry();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Temporarily reduce groq deadline for testing
    const origDeadline = PROVIDER_CALL_DEADLINES.groq;
    PROVIDER_CALL_DEADLINES.groq = 50;

    try {
      await expect(
        runSeatWithTools({
          agent: hangingAgent as any,
          seat: 'a1',
          systemInstruction: 'You are an analyst.',
          prompt: 'event_id=123 | away @ home | options: R1 Over',
          registry,
          budget: { maxPromptChars: 5600, maxOutTokens: 800, maxToolResultChars: 2000, maxToolCalls: 4 },
          finalInstruction: 'answer now'
        })
      ).rejects.toThrow();

      expect(warnSpy).toHaveBeenCalled();
      const seatLog = warnSpy.mock.calls.find((call) => String(call[0]).includes('[seat] a1'));
      expect(seatLog).toBeDefined();
      expect(String(seatLog?.[0])).toMatch(/failed reason=timeout/);
    } finally {
      PROVIDER_CALL_DEADLINES.groq = origDeadline;
      warnSpy.mockRestore();
    }
  });

  it('handleSwarmSse emits swarm_error on workflow run deadline without emitting swarm_complete', async () => {
    const origEnv = process.env.SWARM_RUN_DEADLINE_MS;
    process.env.SWARM_RUN_DEADLINE_MS = '30';

    try {
      const { Hono } = await import('hono');
      const app = new Hono();
      app.get('/sse', async (c) => {
        return handleSwarmSse(c, {
          prompt: 'test prompt',
          data: 'test data',
          workflowExecutor: async () => {
            await new Promise((resolve) => setTimeout(resolve, 150));
            return { status: 'complete', picks: [] } as any;
          }
        } as any);
      });

      const res = await app.request('/sse');
      const text = await res.text();

      expect(text).toContain('event: swarm_error');
      expect(text).toContain('"error":"run_timeout"');
      expect(text).not.toContain('event: swarm_complete');
    } finally {
      process.env.SWARM_RUN_DEADLINE_MS = origEnv;
    }
  });
});

describe('Qdrant 400 Bad Request & Diagnostics (Clause c)', () => {
  it('search returns [] and logs <= 300 char truncated body when client throws 400', async () => {
    const errorBody = {
      status: {
        error: 'Bad Request: validation failed for filter query. Field "unindexed_field" has no payload index configured in Qdrant storage collection.'
      }
    };
    const mockClient: any = {
      getCollections: vi.fn().mockResolvedValue({ collections: [{ name: 'test_cortex' }] }),
      query: vi.fn().mockRejectedValue({
        status: 400,
        data: errorBody
      })
    };

    const adapter = new QdrantStorageAdapter({
      collectionName: 'test_cortex',
      client: mockClient
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const results = await adapter.search(new Array(768).fill(0.01), {
      sport: 'basketball_nba'
    });

    expect(results).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
    const warnCall = warnSpy.mock.calls.find((call) => String(call[0]).includes('[QdrantStorageAdapter] Search error:'));
    expect(warnCall).toBeDefined();
    const logText = String(warnCall?.[0]);
    expect(logText).toContain('status=400');
    expect(logText).toContain('Bad Request: validation failed');
    expect(logText.length).toBeLessThanOrEqual(350);

    warnSpy.mockRestore();
  });
});

describe('Search/Upsert Payload Snapshots & UUIDs (Clause d)', () => {
  it('toValidQdrantId produces valid RFC 4122 UUIDs for arbitrary strings', () => {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

    const id1 = toValidQdrantId('lesson:failure_reflection:12345:abcd');
    const id2 = toValidQdrantId('lesson:failure_reflection:12345:abcd');
    const id3 = toValidQdrantId('bet-998877');

    expect(uuidRegex.test(id1)).toBe(true);
    expect(uuidRegex.test(id3)).toBe(true);
    // Deterministic for same input
    expect(id1).toBe(id2);

    // Passes existing valid UUID as-is
    const realUuid = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
    expect(toValidQdrantId(realUuid)).toBe(realUuid);

    // Passes uint as-is
    expect(toValidQdrantId('123456789')).toBe('123456789');
  });

  it('upsert payload matches Qdrant schema with named dense 768 vector and valid UUID', async () => {
    let capturedUpsert: any = null;
    const mockClient: any = {
      getCollections: vi.fn().mockResolvedValue({ collections: [{ name: 'test_cortex' }] }),
      upsert: vi.fn(async (_col: string, params: any) => {
        capturedUpsert = params;
        return { operation_id: 1, status: 'completed' };
      })
    };

    const adapter = new QdrantStorageAdapter({
      collectionName: 'test_cortex',
      client: mockClient
    });

    const denseVec = new Array(768).fill(0.05);
    const validUuid = toValidQdrantId('lesson_arbitrary_string');

    await adapter.store(
      {
        id: validUuid,
        denseVector: denseVec,
        sparseVector: { indices: [10], values: [0.8] },
        payload: {
          originApp: 'duelodds',
          memoryType: 'graded_lesson',
          sport: 'football_nfl',
          qualityRating: 0.95
        }
      },
      false
    );

    expect(capturedUpsert).toBeDefined();
    expect(capturedUpsert.points).toHaveLength(1);
    const pt = capturedUpsert.points[0];

    // UUID point ID
    expect(pt.id).toBe(validUuid);
    expect(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(pt.id)).toBe(true);

    // Named dense vector with 768 dimensions
    expect(pt.vector.dense).toBeDefined();
    expect(pt.vector.dense).toHaveLength(768);

    // All payload filter keys must match valid indexed schema
    expect(pt.payload.sport).toBe('football_nfl');
    expect(pt.payload.originApp).toBe('duelodds');
  });

  it('search filter payload drops unindexed keys (sportKey, eventId, event_id, eventIds)', async () => {
    let capturedQuery: any = null;
    const mockClient: any = {
      getCollections: vi.fn().mockResolvedValue({ collections: [{ name: 'test_cortex' }] }),
      query: vi.fn(async (_col: string, params: any) => {
        capturedQuery = params;
        return { points: [] };
      })
    };

    const adapter = new QdrantStorageAdapter({
      collectionName: 'test_cortex',
      client: mockClient
    });

    await adapter.search(new Array(768).fill(0.01), {
      sport: 'americanfootball_nfl',
      eventIds: ['ev-1', 'ev-2'],
      entityIds: ['ent-1'],
      domain: 'sports'
    });

    expect(capturedQuery).toBeDefined();
    expect(capturedQuery.filter).toBeDefined();
    const mustFilters = capturedQuery.filter.must;

    // Check that no filter key is sportKey, eventId, event_id, or eventIds
    const filterKeys: string[] = [];
    for (const f of mustFilters) {
      if (f.key) filterKeys.push(f.key);
      if (f.should) {
        for (const s of f.should) {
          if (s.key) filterKeys.push(s.key);
        }
      }
    }

    expect(filterKeys).toContain('sport');
    expect(filterKeys).toContain('entityIds');
    expect(filterKeys).toContain('domain');
    expect(filterKeys).not.toContain('sportKey');
    expect(filterKeys).not.toContain('eventId');
    expect(filterKeys).not.toContain('event_id');
    expect(filterKeys).not.toContain('eventIds');
  });
});
