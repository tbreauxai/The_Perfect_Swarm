import type { SwarmTool, ToolExecutionResult, ToolCallRequest } from './types.ts';
import { standardBuiltinTools } from './builtin.ts';

/**
 * Extracts all top-level JSON objects from a string by scanning for
 * balanced brace pairs. Returns raw JSON substrings.
 */
function extractJsonObjects(text: string): string[] {
    const results: string[] = [];
    let depth = 0;
    let start = -1;
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '{') {
            if (depth === 0) start = i;
            depth++;
        } else if (text[i] === '}') {
            depth--;
            if (depth === 0 && start !== -1) {
                results.push(text.slice(start, i + 1));
                start = -1;
            }
        }
    }
    return results;
}

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

            if (typeof tool.execute !== 'function') {
                return {
                    tool: name,
                    parameters,
                    error: `Tool '${name}' does not implement an execute() function.`,
                    success: false,
                    durationMs: Date.now() - startTime
                };
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

        return `### Available Deterministic Tools\nIMPORTANT: Do NOT use native function/tool calling APIs. You must output the tool request as standard text in the message body.\nYou can invoke available tools by formatting a JSON block:\n\`\`\`tool_execution\n{\n  "tool": "<tool_name>",\n  "parameters": { ... }\n}\n\`\`\`\n\n${toolDefs}`;
    }

    /**
     * Parses tool call blocks from raw model output text.
     */
    parseToolCalls(text: string): ToolCallRequest[] {
        if (!text || typeof text !== 'string') return [];
        const calls: ToolCallRequest[] = [];
        const seen = new Set<string>();

        const addCandidate = (body: string) => {
            try {
                const parsed = JSON.parse(body.trim());
                if (parsed && typeof parsed.tool === 'string' && this.has(parsed.tool)) {
                    const key = `${parsed.tool}:${JSON.stringify(parsed.parameters || {})}`;
                    if (!seen.has(key)) {
                        seen.add(key);
                        calls.push({
                            tool: parsed.tool,
                            parameters: parsed.parameters || {}
                        });
                    }
                }
            } catch {
                // Not valid JSON, ignore
            }
        };

        // 1. Fenced code blocks ```tool_call ... ``` or ```tool_execution ... ``` or ```json ... ```
        const fenceRegex = /```(?:tool_call|tool_execution|json)?\s*([\s\S]*?)```/gi;
        let match: RegExpExecArray | null;
        while ((match = fenceRegex.exec(text)) !== null) {
            const body = match[1].trim();
            const objs = extractJsonObjects(body);
            if (objs.length > 0) {
                for (const o of objs) addCandidate(o);
            } else {
                addCandidate(body);
            }
        }

        // 2. Bracket blocks [TOOL_CALL] ... [/TOOL_CALL] or [TOOL_EXECUTION] ... [/TOOL_EXECUTION]
        const closedBracketRegex = /\[(?:TOOL_CALL|TOOL_EXECUTION)\]([\s\S]*?)\[\/(?:TOOL_CALL|TOOL_EXECUTION)\]/gi;
        while ((match = closedBracketRegex.exec(text)) !== null) {
            const objs = extractJsonObjects(match[1]);
            for (const o of objs) addCandidate(o);
        }

        // 3. Inline bracket blocks [TOOL_CALL: ...] or [TOOL_EXECUTION: ...] or [TOOL_CALL] ...
        const inlineBracketRegex = /\[(?:TOOL_CALL|TOOL_EXECUTION)(?::|\s*)([\s\S]*?)\]/gi;
        while ((match = inlineBracketRegex.exec(text)) !== null) {
            const objs = extractJsonObjects(match[1]);
            for (const o of objs) addCandidate(o);
        }

        // 4. Standalone raw JSON objects if no calls were extracted yet
        if (calls.length === 0) {
            const objs = extractJsonObjects(text);
            for (const o of objs) addCandidate(o);
        }

        return calls;
    }

    /**
     * Strips tool call blocks from text, leaving any surrounding content/JSON.
     */
    stripToolCalls(text: string): string {
        if (!text || typeof text !== 'string') return '';
        return text
            .replace(/```(?:tool_call|tool_execution)\s*[\s\S]*?```/gi, '')
            .replace(/\[(?:TOOL_CALL|TOOL_EXECUTION)\][\s\S]*?\[\/(?:TOOL_CALL|TOOL_EXECUTION)\]/gi, '')
            .replace(/\[(?:TOOL_CALL|TOOL_EXECUTION):\s*\{[\s\S]*?\}\]/gi, '')
            .replace(/\[(?:TOOL_CALL|TOOL_EXECUTION)\s*\{[\s\S]*?\}\]/gi, '')
            .trim();
    }

    /**
     * Executes all tool calls parsed from an array of requests.
     */
    async executeAllToolCalls(calls: ToolCallRequest[]): Promise<ToolExecutionResult[]> {
        return Promise.all(calls.map(call => this.execute(call.tool, call.parameters)));
    }
}

/**
 * Global default tool registry pre-loaded with standard deterministic tools.
 */
export const globalToolRegistry = new ToolRegistry(standardBuiltinTools);
