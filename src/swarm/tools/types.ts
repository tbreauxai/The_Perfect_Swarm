/**
 * Zero-dependency Swarm Tool & Function Calling Type Definitions.
 */

export interface ToolParameterSchema {
    type: 'string' | 'number' | 'boolean' | 'array' | 'object';
    description: string;
    required?: boolean;
    enum?: string[];
}

export interface SwarmTool<TParams = any, TResult = any> {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, ToolParameterSchema>;
    execute(params: TParams): Promise<TResult> | TResult;
}

export interface ToolCallRequest {
    tool: string;
    parameters: Record<string, any>;
}

export interface ToolExecutionResult {
    tool: string;
    parameters: Record<string, any>;
    result?: any;
    error?: string;
    success: boolean;
    durationMs: number;
}
