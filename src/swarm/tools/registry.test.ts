import { describe, it, expect } from 'vitest';
import { ToolRegistry } from './registry.ts';
import type { SwarmTool } from './types.ts';

describe('ToolRegistry', () => {
    const mockTool: SwarmTool = {
        name: 'test_calc',
        description: 'Test addition tool',
        parameters: {
            a: { type: 'number', description: 'first number', required: true },
            b: { type: 'number', description: 'second number', required: false }
        },
        execute(params: { a: number; b?: number }) {
            return params.a + (params.b || 0);
        }
    };

    it('registers and unregisters tools cleanly', () => {
        const reg = new ToolRegistry([mockTool]);
        expect(reg.has('test_calc')).toBe(true);
        expect(reg.get('test_calc')).toBe(mockTool);
        expect(reg.list()).toHaveLength(1);

        expect(reg.unregister('test_calc')).toBe(true);
        expect(reg.has('test_calc')).toBe(false);
        expect(reg.list()).toHaveLength(0);
    });

    it('executes tools successfully with required parameters', async () => {
        const reg = new ToolRegistry([mockTool]);
        const res = await reg.execute('test_calc', { a: 10, b: 5 });
        expect(res.success).toBe(true);
        expect(res.result).toBe(15);
        expect(res.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('returns error when required parameters are missing', async () => {
        const reg = new ToolRegistry([mockTool]);
        const res = await reg.execute('test_calc', { b: 5 });
        expect(res.success).toBe(false);
        expect(res.error).toContain("Missing required parameter 'a'");
    });

    it('handles tools without execute function gracefully', async () => {
        const badTool: any = {
            name: 'broken_tool',
            description: 'No execute function',
            parameters: {}
        };
        const reg = new ToolRegistry([badTool]);
        const res = await reg.execute('broken_tool', {});
        expect(res.success).toBe(false);
        expect(res.error).toContain("does not implement an execute() function");
    });

    it('renders structured prompt schemas for LLMs', () => {
        const reg = new ToolRegistry([mockTool]);
        const schema = reg.renderPromptSchema();
        expect(schema).toContain('Tool: test_calc');
        expect(schema).toContain('Test addition tool');
        expect(schema).toContain('- a (number, required): first number');
    });

    it('parses multiple tool call syntaxes from model text', () => {
        const reg = new ToolRegistry([mockTool]);
        
        // Markdown fence
        const text1 = '```tool_execution\n{"tool": "test_calc", "parameters": {"a": 42}}\n```';
        const parsed1 = reg.parseToolCalls(text1);
        expect(parsed1).toHaveLength(1);
        expect(parsed1[0].tool).toBe('test_calc');
        expect(parsed1[0].parameters.a).toBe(42);

        // Bracket syntax [TOOL_CALL] { ... }
        const text2 = 'Let me compute this: [TOOL_CALL] {"tool": "test_calc", "parameters": {"a": 7, "b": 3}} [/TOOL_CALL]';
        const parsed2 = reg.parseToolCalls(text2);
        expect(parsed2).toHaveLength(1);
        expect(parsed2[0].parameters.a).toBe(7);

        // Inline bracket syntax [TOOL_CALL: { ... }]
        const text3 = '[TOOL_CALL: {"tool": "test_calc", "parameters": {"a": 99}}]';
        const parsed3 = reg.parseToolCalls(text3);
        expect(parsed3).toHaveLength(1);
        expect(parsed3[0].parameters.a).toBe(99);
    });

    it('strips tool calls from text leaving remaining content intact', () => {
        const reg = new ToolRegistry([mockTool]);
        const text = 'Before [TOOL_CALL: {"tool": "test_calc", "parameters": {"a": 1}}] After';
        const stripped = reg.stripToolCalls(text);
        expect(stripped).toBe('Before  After');
    });
});
