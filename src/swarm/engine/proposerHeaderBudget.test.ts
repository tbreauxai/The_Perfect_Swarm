import { describe, it, expect } from 'vitest';
import { proposerHeaderBudget } from './analystExecution.ts';
import { seatBudget } from '../context/promptBudget.ts';

describe('proposerHeaderBudget (S2)', () => {
  it('returns 1680 for groq (5600 * 0.3) and 2400 for 14000-char providers', () => {
    expect(proposerHeaderBudget('groq')).toBe(1680);
    expect(proposerHeaderBudget('openrouter')).toBe(2400);
    expect(proposerHeaderBudget('nvidia')).toBe(2400);
  });

  it('never exceeds seat maxPromptChars for any provider', () => {
    for (const provider of ['groq', 'openrouter', 'nvidia', 'cloudflare', 'gemini', 'mistral', 'default']) {
      const budget = proposerHeaderBudget(provider);
      expect(budget).toBeLessThanOrEqual(seatBudget(provider).maxPromptChars);
      expect(budget).toBeGreaterThan(0);
    }
  });
});
