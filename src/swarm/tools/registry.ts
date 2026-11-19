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

export const BLOCKED_BUILTIN_TOOL_NAMES = new Set<string>([
    'container.exec',
    'shell',
    'bash',
    'python',
    'python_exec',
    'code_interpreter',
    'exec'
]);

const SPORTS_TOOL_BASE_TO_V1: Record<string, string> = {
    get_matchup_fundamentals: 'get_matchup_fundamentals_v1',
    get_injury_and_roster_delta: 'get_injury_and_roster_delta_v1',
    get_environment_and_weather: 'get_environment_and_weather_v1',
    get_market_movement: 'get_market_movement_v1',
    get_player_prop_splits: 'get_player_prop_splits_v1'
};

const SPORTS_TOOL_V1_TO_BASE: Record<string, string> = {
    get_matchup_fundamentals_v1: 'get_matchup_fundamentals',
    get_injury_and_roster_delta_v1: 'get_injury_and_roster_delta',
    get_environment_and_weather_v1: 'get_environment_and_weather',
    get_market_movement_v1: 'get_market_movement',
    get_player_prop_splits_v1: 'get_player_prop_splits'
};

export function isBlockedBuiltinTool(name: unknown): boolean {
    if (typeof name !== 'string') return false;
    const norm = name.trim().toLowerCase();
    if (!norm) return false;
    return BLOCKED_BUILTIN_TOOL_NAMES.has(norm) || norm.startsWith('container.') || norm.startsWith('functions.container.');
}

export function getSportsToolAlias(name: string): string | undefined {
    const trimmed = name.trim();
    return SPORTS_TOOL_BASE_TO_V1[trimmed] || SPORTS_TOOL_V1_TO_BASE[trimmed];
}

export function toCanonicalOpenAiToolName(name: string): string {
    const trimmed = name.trim();
    return SPORTS_TOOL_BASE_TO_V1[trimmed] || trimmed;
}

/**
 * Registry for managing and executing deterministic tools in the Swarm runtime.
 */
export class ToolRegistry {
    private tools: Map<string, SwarmTool> = new Map();
    private whitelist?: Set<string>;

    constructor(initialTools?: SwarmTool[], whitelist?: string[]) {
        if (whitelist) {
            const expanded = new Set<string>();
            for (const raw of whitelist) {
                const n = String(raw).trim();
                if (!n || isBlockedBuiltinTool(n)) continue;
                expanded.add(n);
                const alias = getSportsToolAlias(n);
                if (alias) expanded.add(alias);
            }
            this.whitelist = expanded;
        }
        if (initialTools) {
            this.registerAll(initialTools);
        }
    }

    private isWhitelisted(name: string): boolean {
        if (!this.whitelist) return true;
        if (this.whitelist.has(name)) return true;
        const alias = getSportsToolAlias(name);
        return Boolean(alias && this.whitelist.has(alias));
    }

    private resolveRegisteredKey(name: string): string | undefined {
        const trimmed = String(name || '').trim();
        if (!trimmed || isBlockedBuiltinTool(trimmed)) return undefined;
        if (this.tools.has(trimmed)) return trimmed;
        const alias = getSportsToolAlias(trimmed);
        if (alias && this.tools.has(alias)) return alias;
        return undefined;
    }

    register(tool: SwarmTool): void {
        if (!tool || !tool.name) {
            throw new Error('Tool must have a valid name.');
        }
        if (isBlockedBuiltinTool(tool.name)) {
            return;
        }
        if (!this.isWhitelisted(tool.name)) {
            return;
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
        const key = this.resolveRegisteredKey(name);
        if (!key || !this.isWhitelisted(key)) {
            return undefined;
        }
        return this.tools.get(key);
    }

    has(name: string): boolean {
        const key = this.resolveRegisteredKey(name);
        if (!key) return false;
        return this.isWhitelisted(key);
    }

    list(): SwarmTool[] {
        const all = Array.from(this.tools.values()).filter((t) => !isBlockedBuiltinTool(t.name));
        if (!this.whitelist) return all;
        return all.filter((t) => this.isWhitelisted(t.name));
    }

    /**
     * Creates a child scoped ToolRegistry strictly restricted to the specified whitelisted tool names.
     */
    scoped(whitelistedNames: string[]): ToolRegistry {
        const allowedSet = new Set<string>();
        const priorityIndex = new Map<string, number>();
        whitelistedNames.forEach((raw, idx) => {
            const n = String(raw).trim();
            if (!n || isBlockedBuiltinTool(n)) return;
            allowedSet.add(n);
            if (!priorityIndex.has(n)) priorityIndex.set(n, idx);
            const alias = getSportsToolAlias(n);
            if (alias) {
                allowedSet.add(alias);
                if (!priorityIndex.has(alias)) priorityIndex.set(alias, idx);
            }
        });
        const filtered = this.list()
            .filter((t) => allowedSet.has(t.name))
            .sort((a, b) => (priorityIndex.get(a.name) ?? Number.MAX_SAFE_INTEGER) - (priorityIndex.get(b.name) ?? Number.MAX_SAFE_INTEGER));
        return new ToolRegistry(filtered, Array.from(allowedSet));
    }

    /**
     * Executes a tool by name with parameter validation and timing.
     */
    async execute(name: string, parameters: any = {}): Promise<ToolExecutionResult> {
        const startTime = Date.now();

        if (isBlockedBuiltinTool(name)) {
            return {
                tool: name,
                parameters,
                error: `Tool '${name}' is blocked (built-in code/shell execution tools are not permitted).`,
                success: false,
                durationMs: Date.now() - startTime
            };
        }

        const resolvedKey = this.resolveRegisteredKey(name);
        if (this.whitelist && !this.isWhitelisted(resolvedKey || name)) {
            return {
                tool: name,
                parameters,
                error: `Tool '${name}' is not permitted by the scoped manifest whitelist. Available tools: ${Array.from(this.whitelist).join(', ')}`,
                success: false,
                durationMs: Date.now() - startTime
            };
        }

        const tool = resolvedKey ? this.tools.get(resolvedKey) : undefined;

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
                tool: tool.name,
                parameters,
                result,
                success: true,
                durationMs: Date.now() - startTime
            };
        } catch (err: any) {
            return {
                tool: tool.name,
                parameters,
                error: err?.message || String(err),
                success: false,
                durationMs: Date.now() - startTime
            };
        }
    }

    /**
     * Converts the registry into OpenAI-compatible function-calling definitions,
     * advertising canonical _v1 names for filtered sports data tools and stripping blocked tools.
     */
    toOpenAiTools(): any[] {
        return this.list().map((tool) => {
            const required: string[] = [];
            const properties: Record<string, any> = {};

            for (const [paramName, schema] of Object.entries(tool.parameters || {})) {
                const property: Record<string, any> = {
                    type: schema.type,
                    description: schema.description
                };
                if (schema.enum) property.enum = schema.enum;
                properties[paramName] = property;
                if (schema.required) required.push(paramName);
            }

            return {
                type: 'function',
                function: {
                    name: toCanonicalOpenAiToolName(tool.name),
                    description: tool.description,
                    parameters: {
                        type: 'object',
                        properties,
                        required,
                        additionalProperties: false
                    }
                }
            };
        });
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
                if (!parsed || typeof parsed !== 'object') return;
                const rawName = parsed.tool ?? parsed.name ?? parsed.function?.name;
                if (typeof rawName !== 'string') return;
                const trimmedName = rawName.trim();
                if (!trimmedName || trimmedName.toLowerCase() === 'json' || isBlockedBuiltinTool(trimmedName)) return;
                const resolvedKey = this.resolveRegisteredKey(trimmedName)
                    ?? (trimmedName.endsWith('_v1') ? this.resolveRegisteredKey(trimmedName.slice(0, -3)) : undefined);
                const resolvedName = resolvedKey && this.isWhitelisted(resolvedKey) ? resolvedKey : null;
                if (!resolvedName) return;

                let rawArgs = parsed.parameters ?? parsed.arguments ?? parsed.function?.parameters ?? parsed.function?.arguments ?? {};
                if (typeof rawArgs === 'string') {
                    try {
                        rawArgs = JSON.parse(rawArgs);
                    } catch {
                        rawArgs = {};
                    }
                }
                if (!rawArgs || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) {
                    rawArgs = {};
                }
                const key = `${resolvedName}:${JSON.stringify(rawArgs)}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    calls.push({
                        tool: resolvedName,
                        parameters: rawArgs
                    });
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
