import { describe, it, expect } from 'vitest';
import { seatBudget, assertPromptFits } from './promptBudget.ts';

describe('Prompt Budget & Bounds (PS2 Groq 6k TPM Safe)', () => {
  it('returns groq budget of 5600 chars and 800 out tokens', () => {
    const budget = seatBudget('groq');
    expect(budget.maxPromptChars).toBe(5600);
    expect(budget.maxOutTokens).toBe(800);
    expect(budget.maxToolResultChars).toBe(2000);
    expect(budget.maxToolCalls).toBe(6);
  });

  it('returns openrouter / gemini / mistral budget of 14000 chars', () => {
    for (const p of ['openrouter', 'gemini', 'mistral', 'default', undefined]) {
      const budget = seatBudget(p);
      expect(budget.maxPromptChars).toBe(14000);
      expect(budget.maxOutTokens).toBe(1500);
      expect(budget.maxToolResultChars).toBe(6000);
      expect(budget.maxToolCalls).toBe(8);
    }
  });

  it('passes when prompt is within budget', () => {
    const result = assertPromptFits('groq', {
      systemInstruction: 'You are an analyst.',
      toolSchemas: '{"name": "tool1"}',
      prompt: 'Evaluate game-123'
    });
    expect(result).toContain('You are an analyst.');
    expect(result).toContain('Evaluate game-123');
  });

  it('throws in test environment when total parts exceed budget', () => {
    const hugePrompt = 'A'.repeat(5700);
    expect(() => {
      assertPromptFits(
        'groq',
        { prompt: hugePrompt },
        { isTest: true }
      );
    }).toThrow(/Prompt exceeds groq budget: 5700 chars > 5600 max/);
  });

  it('trims reports and tool results in prod mode without throwing or trimming instructions', () => {
    const instructions = 'System instructions: analyze odds.';
    const hugeReports = 'R'.repeat(4000);
    const hugeTools = 'T'.repeat(3000);

    const result = assertPromptFits(
      'groq',
      {
        systemInstruction: instructions,
        reports: hugeReports,
        toolResults: hugeTools
      },
      { isTest: false }
    );

    expect(result).toContain(instructions);
    expect(result).toContain('[truncated]');
    expect(result.length).toBeLessThanOrEqual(5600);
  });
});
