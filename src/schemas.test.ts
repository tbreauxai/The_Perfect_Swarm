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
    ui_title: 'Dashboard',
    components: [
      {
        id: '1',
        type: 'MetricCard',
        props: { title: 'T', value: 'V', trend: 'up' }
      }
    ]
  };
  
  const result = ManagerResponseSchema.safeParse(validOutput);
  expect(result.success).toBe(true);
});

test('ManagerResponseSchema normalizes case variations and synonyms in trend', () => {
  const cases: Array<[any, 'up' | 'down' | 'neutral' | undefined]> = [
    ['UP', 'up'],
    ['increasing', 'up'],
    ['upward', 'up'],
    ['positive', 'up'],
    ['+15%', 'up'],
    ['DOWN', 'down'],
    ['decreasing', 'down'],
    ['downward', 'down'],
    ['negative', 'down'],
    ['-5%', 'down'],
    ['flat', 'neutral'],
    ['stable', 'neutral'],
    ['neutral', 'neutral'],
    ['none', 'neutral'],
    ['=0', 'neutral'],
    ['invalid-random-trend', undefined],
    [null, undefined],
    [undefined, undefined]
  ];

  for (const [inputTrend, expectedTrend] of cases) {
    const payload = {
      ui_title: 'Dashboard',
      components: [
        {
          id: 'card-1',
          type: 'MetricCard',
          props: {
            title: 'Test Metric',
            value: 99, // also tests numeric coerce
            trend: inputTrend
          }
        }
      ]
    };

    const parsed = ManagerResponseSchema.safeParse(payload);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      const card = parsed.data.components[0] as any;
      expect(card.props.trend).toBe(expectedTrend);
      expect(card.props.value).toBe('99');
    }
  }
});

test('ManagerResponseSchema normalizes insight types gracefully', () => {
  const payload = {
    ui_title: 'Dashboard',
    components: [
      {
        id: 'insights-1',
        type: 'InsightList',
        props: {
          title: 'System Insights',
          insights: [
            { type: 'alert', message: 'Warning alert' },
            { type: 'danger', message: 'Danger error' },
            { type: 'good', message: 'Good success' },
            { type: 'unrecognized_type', message: 'Fallback to info' }
          ]
        }
      }
    ]
  };

  const parsed = ManagerResponseSchema.safeParse(payload);
  expect(parsed.success).toBe(true);
  if (parsed.success) {
    const list = parsed.data.components[0] as any;
    expect(list.props.insights[0].type).toBe('warning');
    expect(list.props.insights[1].type).toBe('error');
    expect(list.props.insights[2].type).toBe('success');
    expect(list.props.insights[3].type).toBe('info');
  }
});

