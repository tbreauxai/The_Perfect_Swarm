import { describe, it, expect, vi, afterEach } from 'vitest';
import { warnUnknownConfiguredModels } from './modelsProvider.ts';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const groqList = (ids: string[]) =>
  vi.fn(async () => new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status: 200 }));

describe('warnUnknownConfiguredModels', () => {
  it('warns for an unknown groq id', async () => {
    vi.stubGlobal('fetch', groqList(['openai/gpt-oss-120b', 'openai/gpt-oss-20b']));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = await warnUnknownConfiguredModels({ groq: ['openai/gpt-oss-120b', 'retired-model-x'] }, { GROQ_API_KEY: 'k' });
    expect(out).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('no warning when all ids are listed', async () => {
    vi.stubGlobal('fetch', groqList(['openai/gpt-oss-120b', 'openai/gpt-oss-20b']));
    expect(await warnUnknownConfiguredModels({ groq: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'] }, { GROQ_API_KEY: 'k' })).toEqual([]);
  });

  it('skips providers without a key and never throws on fetch failure', async () => {
    const f = vi.fn(async () => { throw new Error('network'); });
    vi.stubGlobal('fetch', f);
    await expect(warnUnknownConfiguredModels({ groq: ['x'] }, {})).resolves.toEqual([]);
    expect(f).not.toHaveBeenCalled();
    await expect(warnUnknownConfiguredModels({ groq: ['x'] }, { GROQ_API_KEY: 'k' })).resolves.toEqual([]);
  });

  it('recognizes the OpenRouter nemotron instant model from the live list', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'nvidia/nemotron-3-super-120b-a12b:free', pricing: { prompt: '0', completion: '0' } }] }), { status: 200 })));
    const out = await warnUnknownConfiguredModels(
      { openrouter: ['nvidia/nemotron-3-super-120b-a12b:free'] },
      { OPENROUTER_API_KEY: 'k' }
    );
    expect(out).toEqual([]);
  });
});

