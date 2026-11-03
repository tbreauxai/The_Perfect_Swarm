import { describe, it, expect } from 'vitest';
import { repairJson, extractFuzzyFields } from './repairJson';

describe('repairJson', () => {
  it('should handle basic valid JSON strings', () => {
    expect(repairJson('{"key": "value"}')).toBe('{"key": "value"}');
    expect(repairJson('[1, 2, 3]')).toBe('[1, 2, 3]');
    expect(repairJson('{}')).toBe('{}');
    expect(repairJson('[]')).toBe('[]');
  });

  it('should return {} for falsy or non-string inputs', () => {
    expect(repairJson('')).toBe('{}');
    expect(repairJson(null as any)).toBe('{}');
    expect(repairJson(undefined as any)).toBe('{}');
    expect(repairJson(123 as any)).toBe('{}');
  });

  it('should strip reasoning tags', () => {
    const input1 = '<think>Let me think...</think>{"key": "value"}';
    expect(repairJson(input1)).toBe('{"key": "value"}');

    const input2 = '<reasoning>Some reasoning</reasoning>[1, 2, 3]';
    expect(repairJson(input2)).toBe('[1, 2, 3]');

    const input3 = '<thought>A thought</thought>{"a": 1}';
    expect(repairJson(input3)).toBe('{"a": 1}');

    const input4 = '[THOUGHT]Thinking...[/THOUGHT]{"b": 2}';
    expect(repairJson(input4)).toBe('{"b": 2}');

    const input5 = '```tool_call\nsome tool call\n```{"c": 3}';
    expect(repairJson(input5)).toBe('{"c": 3}');
  });

  it('should handle unclosed <think> tag if model was truncated mid-reasoning', () => {
    const input1 = '<think>I should output JSON now\n{"key": "value"}';
    expect(repairJson(input1)).toBe('{"key": "value"}');

    const input2 = '<think>I should output JSON now';
    expect(repairJson(input2)).toBe('{}'); // No JSON found
  });

  it('should strip markdown fences', () => {
    expect(repairJson('```json\n{"key": "value"}\n```')).toBe('{"key": "value"}');
    expect(repairJson('```\n{"key": "value"}\n```')).toBe('{"key": "value"}');
    expect(repairJson('```javascript\n{"key": "value"}\n```')).toBe('{"key": "value"}');
    expect(repairJson('```js\n{"key": "value"}\n```')).toBe('{"key": "value"}');
  });

  it('should extract JSON embedded within conversational text', () => {
    const input = 'Here is the result:\n{"key": "value"}\nHope this helps!';
    expect(repairJson(input)).toBe('{"key": "value"}');
  });

  it('should convert single quotes to double quotes for strings', () => {
    expect(repairJson("{'key': 'value'}")).toBe('{"key": "value"}');
  });

  it('should fix unquoted object keys', () => {
    expect(repairJson('{key: "value"}')).toBe('{"key": "value"}');
    expect(repairJson('{key1: "value1", key2: "value2"}')).toBe('{"key1": "value1", "key2": "value2"}');
    expect(repairJson('{_key$: "value"}')).toBe('{"_key$": "value"}');
  });

  it('should parse Python/JS literals', () => {
    expect(repairJson('{"a": True, "b": False, "c": None, "d": undefined}')).toBe('{"a": true, "b": false, "c": null, "d": null}');
  });

  it('should strip single-line and multi-line comments', () => {
    expect(repairJson('{\n// comment\n"key": "value"\n}')).toBe('{\n\n"key": "value"\n}');
    expect(repairJson('{\n/* comment */\n"key": "value"\n}')).toBe('{\n\n"key": "value"\n}');
    expect(repairJson('{"key": "value"} // trailing comment')).toBe('{"key": "value"}');
  });

  it('should repair truncated JSON (auto-closing strings, brackets, and braces)', () => {
    expect(repairJson('{"key": "value')).toBe('{"key": "value"}'); // auto-close string and brace
    expect(repairJson('{"key": "value"')).toBe('{"key": "value"}'); // auto-close brace
    expect(repairJson('{"key": {"nested": "value"')).toBe('{"key": {"nested": "value"}}'); // auto-close nested
    expect(repairJson('[1, 2, 3')).toBe('[1, 2, 3]'); // auto-close bracket
    expect(repairJson('{"key": [1, 2')).toBe('{"key": [1, 2]}'); // auto-close bracket and brace
  });

  it('should remove trailing commas and dangling keys/colons', () => {
    expect(repairJson('{"key": "value",}')).toBe('{"key": "value"}');
    expect(repairJson('[1, 2, 3,]')).toBe('[1, 2, 3]');
    expect(repairJson('{"key": "value",')).toBe('{"key": "value"}'); // trailing comma at EOF
    expect(repairJson('{"key":')).toBe('{"key": null}'); // dangling colon at EOF
    expect(repairJson('{"key1": "v1", "key2": ')).toBe('{"key1": "v1", "key2": null}');
  });

  it('should handle complex escaped characters inside strings', () => {
      expect(repairJson('{"key": "value\\"with\\"quotes"}')).toBe('{"key": "value\\"with\\"quotes"}');
      expect(repairJson('{"key": "value\\nnewline"}')).toBe('{"key": "value\\nnewline"}');
      expect(repairJson('{"key": "value\\t"}')).toBe('{"key": "value\\t"}');
  });
});

describe('extractFuzzyFields', () => {
  it('should return null for falsy or non-string inputs', () => {
    expect(extractFuzzyFields('')).toBeNull();
    expect(extractFuzzyFields(null as any)).toBeNull();
    expect(extractFuzzyFields(undefined as any)).toBeNull();
    expect(extractFuzzyFields(123 as any)).toBeNull();
  });

  it('should extract summary', () => {
    const input = 'Summary: This is a test summary.\nOther text here.';
    expect(extractFuzzyFields(input)).toEqual({ summary: 'This is a test summary.', anomalies: [] });

    const input2 = 'Executive Summary - Another summary\nInsights: ...';
    expect(extractFuzzyFields(input2)).toEqual({ summary: 'Another summary', anomalies: [] });
  });

  it('should extract insights', () => {
    const input = 'Insights:\n- Insight 1\n* Insight 2\n1. Insight 3\nSummary: text';
    expect(extractFuzzyFields(input)).toEqual({
      insights: ['Insight 1', 'Insight 2', 'Insight 3'],
      summary: 'text',
      anomalies: []
    });
  });

  it('should extract anomalies', () => {
    const input = 'Anomalies:\n- Anomaly 1\n- Anomaly 2\nSummary: text';
    expect(extractFuzzyFields(input)).toEqual({
      anomalies: ['Anomaly 1', 'Anomaly 2'],
      summary: 'text'
    });
  });

  it('should ignore "none" anomalies', () => {
    const input = 'Anomalies:\n- none\n- None\nSummary: text';
    expect(extractFuzzyFields(input)).toEqual({
      anomalies: [],
      summary: 'text'
    });
  });

  it('should extract all fields together', () => {
    const input = `
      Executive Summary: Overall looking good.
      Key Points:
      - Point 1
      - Point 2
      Anomalies:
      - Warning A
    `;
    const result = extractFuzzyFields(input);
    expect(result).toEqual({
      summary: 'Overall looking good.',
      insights: ['Point 1', '- Point 2'],
      anomalies: ['Warning A']
    });
  });

  it('should return null if no fields match', () => {
      const input = 'Just some random text with no matching headers.';
      expect(extractFuzzyFields(input)).toEqual({ anomalies: [] });
  });
});
