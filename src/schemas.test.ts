import { expect, test } from 'vitest';
import { AnalystResponseSchema, ManagerResponseSchema } from './schemas';

test('AnalystResponseSchema validates correct output', () => {
  const validOutput = {
    insights: ['Insight 1', 'Insight 2'],
    anomalies: ['Anomaly 1'],
    summary: 'A summary'
  };
  
  const result = AnalystResponseSchema.safeParse(validOutput);
  expect(result.success).toBe(true);
});

test('AnalystResponseSchema rejects invalid output', () => {
  const invalidOutput = {
    insights: 'Insight 1', // should be array
    summary: 'A summary' // missing anomalies
  };
  
  const result = AnalystResponseSchema.safeParse(invalidOutput);
  expect(result.success).toBe(false);
});

test('ManagerResponseSchema validates correct output', () => {
  const validOutput = {
    synthesis: 'A synthesized report',
    action_plan: [
      { step: 'Step 1', description: 'Description 1' }
    ]
  };
  
  const result = ManagerResponseSchema.safeParse(validOutput);
  expect(result.success).toBe(true);
});
