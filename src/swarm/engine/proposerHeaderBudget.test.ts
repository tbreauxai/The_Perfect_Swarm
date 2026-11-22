import { describe, it, expect } from 'vitest';
import { proposerHeaderBudget } from './analystExecution.ts';
import { seatBudget } from '../context/promptBudget.ts';

describe('proposerHeaderBudget (S2)', () => {
  it('returns 1680 for groq, 2160 for mistral, 6600 for openrouter/cloudflare, and 8400 for nvidia/gemini', () => {
    expect(proposerHeaderBudget('groq')).toBe(1680);
    expect(proposerHeaderBudget('mistral')).toBe(2160);
    expect(proposerHeaderBudget('openrouter')).toBe(6600);
    expect(proposerHeaderBudget('cloudflare')).toBe(6600);
    expect(proposerHeaderBudget('nvidia')).toBe(8400);
    expect(proposerHeaderBudget('gemini')).toBe(8400);
  });

  it('never exceeds seat maxPromptChars for any provider', () => {
    for (const provider of ['groq', 'openrouter', 'nvidia', 'cloudflare', 'gemini', 'mistral', 'default']) {
      const budget = proposerHeaderBudget(provider);
      expect(budget).toBeLessThanOrEqual(seatBudget(provider).maxPromptChars);
      expect(budget).toBeGreaterThan(0);
    }
  });
});
