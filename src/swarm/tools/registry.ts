import type { SwarmTool, ToolExecutionResult, ToolCallRequest } from './types.ts';
import { standardBuiltinTools } from './builtin.ts';

/**
 * Registry for managing and executing deterministic tools in the Swarm runtime.
 */
export class ToolRegistry {
    private tools: Map<string, SwarmTool> = new Map();

    constructor(initialTools?: SwarmTool[]) {
        if (initialTools) {
            this.registerAll(initialTools);
        }
    }

    register(tool: SwarmTool): void {
        if (!tool || !tool.name) {
            throw new Error('Tool must have a valid name.');
        }
        this.tools.set(tool.name, tool);
    }

    registerAll(tools: SwarmTool[]): void {
        for (const tool of tools) {
            this.register(tool);
        }
    }

    unregister(name: string): boolean {
        return this.tools.delete(name);
    }

    get(name: string): SwarmTool | undefined {
        return this.tools.get(name);
    }

    has(name: string): boolean {
        return this.tools.has(name);
    }

    list(): SwarmTool[] {
        return Array.from(this.tools.values());
    }

    /**
     * Executes a tool by name with parameter validation and timing.
     */
    async execute(name: string, parameters: any = {}): Promise<ToolExecutionResult> {
        const startTime = Date.now();
        const tool = this.tools.get(name);

        if (!tool) {
            return {
                tool: name,
                parameters,
                error: `Tool '${name}' is not registered in ToolRegistry. Available tools: ${Array.from(this.tools.keys()).join(', ')}`,
                success: false,
                durationMs: Date.now() - startTime
            };
        }

        try {
            // Verify required parameters
            if (tool.parameters) {
                for (const [paramName, schema] of Object.entries(tool.parameters)) {
                    if (schema.required && (parameters[paramName] === undefined || parameters[paramName] === null)) {
                        throw new Error(`Missing required parameter '${paramName}' for tool '${name}'. Description: ${schema.description}`);
                    }
                }
            }

            const result = await tool.execute(parameters);
            return {
                tool: name,
                parameters,
                result,
                success: true,
                durationMs: Date.now() - startTime
            };
        } catch (err: any) {
            return {
                tool: name,
                parameters,
                error: err?.message || String(err),
                success: false,
                durationMs: Date.now() - startTime
            };
        }
    }

    /**
     * Formats available tools into a structured prompt schema for LLM instruction injection.
     */
    renderPromptSchema(): string {
        const toolsList = this.list();
        if (toolsList.length === 0) return '';

        const toolDefs = toolsList.map(t => {
            const paramsDesc = Object.entries(t.parameters || {})
                .map(([pName, pSchema]) => `    - ${pName} (${pSchema.type}${pSchema.required ? ', required' : ''}): ${pSchema.description}`)
                .join('\n');

            return `Tool: ${t.name}\nDescription: ${t.description}\nParameters:\n${paramsDesc}`;
        }).join('\n\n');

        return `### Available Deterministic Tools\nYou can invoke available tools by formatting a JSON block:\n\`\`\`tool_call\n{\n  "tool": "<tool_name>",\n  "parameters": { ... }\n}\n\`\`\`\n\n${toolDefs}`;
    }

    /**
     * Parses tool call blocks from raw model output text.
     */
    parseToolCalls(text: string): ToolCallRequest[] {
        if (!text || typeof text !== 'string') return [];
        const calls: ToolCallRequest[] = [];

        // Match ```tool_call ... ``` or ```json ... ``` with {"tool": "...", "parameters": ...}
        const regex = /```(?:tool_call|json)?\s*([\s\S]*?)```/gi;
        let match: RegExpExecArray | null;

        while ((match = regex.exec(text)) !== null) {
            const body = match[1].trim();
            try {
                const parsed = JSON.parse(body);
                if (parsed && typeof parsed.tool === 'string' && this.has(parsed.tool)) {
                    calls.push({
                        tool: parsed.tool,
                        parameters: parsed.parameters || {}
                    });
                }
            } catch {
                // Not valid JSON or not a tool call block, ignore
            }
        }

        // Also check if entire string is a standalone raw JSON tool call
        if (calls.length === 0 && text.trim().startsWith('{')) {
            try {
                const parsed = JSON.parse(text.trim());
                if (parsed && typeof parsed.tool === 'string' && this.has(parsed.tool)) {
                    calls.push({
                        tool: parsed.tool,
                        parameters: parsed.parameters || {}
                    });
                }
            } catch {
                // Ignore
            }
        }

        return calls;
    }

    /**
     * Strips tool call blocks from text, leaving any surrounding content/JSON.
     */
    stripToolCalls(text: string): string {
        if (!text || typeof text !== 'string') return '';
        return text.replace(/```(?:tool_call)\s*[\s\S]*?```/gi, '').trim();
    }

    /**
     * Executes all tool calls parsed from an array of requests.
     */
    async executeAllToolCalls(calls: ToolCallRequest[]): Promise<ToolExecutionResult[]> {
        const results: ToolExecutionResult[] = [];
        for (const call of calls) {
            const res = await this.execute(call.tool, call.parameters);
            results.push(res);
        }
        return results;
    }
}

/**
 * Global default tool registry pre-loaded with standard deterministic tools.
 */
export const globalToolRegistry = new ToolRegistry(standardBuiltinTools);
