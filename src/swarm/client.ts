import { executeSwarmWorkflow, type SwarmWorkflowResult, type SwarmStagePayload, getOrCreateDefaultCortex } from './engine/index.ts';
import { MemoryCortex, type RetrievalOptions, type MemorySnapshot, type ExportMemoriesOptions, type ImportMemoriesOptions, type ImportMemoriesResult, type MemoryMetadata } from './memory.ts';
import type { SwarmEvent } from './types.ts';

export type ClientExecutionMode = 'embedded' | 'remote';

export interface SwarmClientConfig {
    mode?: ClientExecutionMode;
    appId?: string;
    serverUrl?: string;
    endpoint?: string;
    apiKey?: string;
    settings?: any;
    qdrantUrl?: string;
    qdrantApiKey?: string;
    enableDeepAnalysis?: boolean;
    forceFullSwarm?: boolean;
    persistPath?: string;
    autoSave?: boolean;
}

export interface AnalyzeRequest {
    task: string;
    data?: string;
    settings?: any;
    enableDeepAnalysis?: boolean;
    forceFullSwarm?: boolean;
}

export interface AnalyzeResponse {
    finalAnalysis: any;
    events: SwarmEvent[];
}

export interface StreamEventPayload {
    type: 'event' | 'stage' | 'complete' | 'error';
    event?: SwarmEvent;
    stagePayload?: SwarmStagePayload;
    finalAnalysis?: any;
    error?: string;
}

/**
 * Unified Multi-App Swarm Client.
 * Provides a single ergonomic API to run autonomous swarm analysis, stream reasoning events,
 * and access the continuous learning cortex across both embedded in-process engines and remote HTTP/SSE servers.
 */
export class SwarmClient {
    public readonly mode: ClientExecutionMode;
    public readonly appId: string;
    private readonly serverUrl: string;
    private readonly apiKey?: string;
    private readonly defaultSettings: any;
    private readonly cortex: MemoryCortex;

    constructor(config: SwarmClientConfig = {}) {
        this.mode = config.mode || 'embedded';
        this.appId = config.appId || 'perfect-swarm';
        this.serverUrl = (config.serverUrl || config.endpoint || 'http://127.0.0.1:3000').replace(/\/+$/, '');
        this.apiKey = config.apiKey;
        this.defaultSettings = {
            appId: this.appId,
            enableDeepAnalysis: config.enableDeepAnalysis,
            forceFullSwarm: config.forceFullSwarm,
            persistPath: config.persistPath,
            autoSave: config.autoSave,
            ...(config.settings || {})
        };

        if (config.persistPath) {
            this.cortex = new MemoryCortex({
                url: config.qdrantUrl,
                apiKey: config.qdrantApiKey,
                defaultAppId: this.appId,
                persistPath: config.persistPath,
                autoSave: config.autoSave
            });
        } else if (config.qdrantUrl) {
            this.cortex = new MemoryCortex({
                url: config.qdrantUrl,
                apiKey: config.qdrantApiKey,
                defaultAppId: this.appId
            });
        } else {
            this.cortex = getOrCreateDefaultCortex(this.appId);
        }
    }

    /**
     * Executes a swarm analysis task and returns the complete final analysis and event history.
     */
    async analyze(request: AnalyzeRequest): Promise<AnalyzeResponse> {
        if (this.mode === 'remote') {
            return this.analyzeRemote(request);
        }
        return this.analyzeEmbedded(request);
    }

    private async analyzeEmbedded(request: AnalyzeRequest): Promise<AnalyzeResponse> {
        const mergedSettings = {
            ...this.defaultSettings,
            ...(request.settings || {})
        };

        const result: SwarmWorkflowResult = await executeSwarmWorkflow({
            task: request.task,
            data: request.data,
            settings: mergedSettings,
            enableDeepAnalysis: request.enableDeepAnalysis ?? this.defaultSettings.enableDeepAnalysis,
            forceFullSwarm: request.forceFullSwarm ?? this.defaultSettings.forceFullSwarm,
            cortex: this.cortex
        });

        return {
            finalAnalysis: result.finalAnalysis,
            events: result.events
        };
    }

    private async analyzeRemote(request: AnalyzeRequest): Promise<AnalyzeResponse> {
        const headers: Record<string, string> = {
            'Content-Type': 'application/json'
        };
        if (this.apiKey) {
            headers['Authorization'] = `Bearer ${this.apiKey}`;
        }

        const res = await fetch(`${this.serverUrl}/api/swarm/analyze`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                task: request.task,
                data: request.data,
                settings: {
                    ...this.defaultSettings,
                    ...(request.settings || {})
                },
                enableDeepAnalysis: request.enableDeepAnalysis ?? this.defaultSettings.enableDeepAnalysis,
                forceFullSwarm: request.forceFullSwarm ?? this.defaultSettings.forceFullSwarm
            })
        });

        if (!res.ok) {
            const errText = await res.text();
            throw new Error(`Remote Swarm server returned error ${res.status}: ${errText}`);
        }

        const data: any = await res.json();
        return {
            finalAnalysis: data.finalAnalysis,
            events: data.events || []
        };
    }

    /**
     * Streams live reasoning events and the final generative UI analysis via an AsyncIterable.
     */
    async *stream(request: AnalyzeRequest): AsyncIterable<StreamEventPayload> {
        if (this.mode === 'remote') {
            yield* this.streamRemote(request);
        } else {
            yield* this.streamEmbedded(request);
        }
    }

    private async *streamEmbedded(request: AnalyzeRequest): AsyncIterable<StreamEventPayload> {
        const eventQueue: StreamEventPayload[] = [];
        let isDone = false;
        let resolveNext: (() => void) | null = null;

        const pushItem = (item: StreamEventPayload) => {
            eventQueue.push(item);
            if (resolveNext) {
                resolveNext();
                resolveNext = null;
            }
        };

        const mergedSettings = {
            ...this.defaultSettings,
            ...(request.settings || {})
        };

        const executionPromise = executeSwarmWorkflow({
            task: request.task,
            data: request.data,
            settings: mergedSettings,
            enableDeepAnalysis: request.enableDeepAnalysis ?? this.defaultSettings.enableDeepAnalysis,
            forceFullSwarm: request.forceFullSwarm ?? this.defaultSettings.forceFullSwarm,
            cortex: this.cortex,
            onEvent: (event) => {
                pushItem({ type: 'event', event });
            },
            onStage: (stagePayload) => {
                pushItem({ type: 'stage', stagePayload });
            }
        }).then(result => {
            pushItem({ type: 'complete', finalAnalysis: result.finalAnalysis });
        }).catch(err => {
            const errorMsg = err?.message || String(err);
            pushItem({
                type: 'error',
                error: errorMsg,
                finalAnalysis: { ui_title: 'Execution Error', error: errorMsg }
            });
        }).finally(() => {
            isDone = true;
            if (resolveNext) {
                resolveNext();
                resolveNext = null;
            }
        });

        while (!isDone || eventQueue.length > 0) {
            if (eventQueue.length === 0) {
                await new Promise<void>(resolve => { resolveNext = resolve; });
            }
            while (eventQueue.length > 0) {
                yield eventQueue.shift()!;
            }
        }

        await executionPromise;
    }

    private async *streamRemote(request: AnalyzeRequest): AsyncIterable<StreamEventPayload> {
        const headers: Record<string, string> = {
            'Content-Type': 'application/json'
        };
        if (this.apiKey) {
            headers['Authorization'] = `Bearer ${this.apiKey}`;
        }

        const res = await fetch(`${this.serverUrl}/api/swarm/stream`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                task: request.task,
                data: request.data,
                settings: {
                    ...this.defaultSettings,
                    ...(request.settings || {})
                },
                enableDeepAnalysis: request.enableDeepAnalysis ?? this.defaultSettings.enableDeepAnalysis,
                forceFullSwarm: request.forceFullSwarm ?? this.defaultSettings.forceFullSwarm
            })
        });

        if (!res.ok || !res.body) {
            const errText = await res.text();
            throw new Error(`Remote SSE server connection failed ${res.status}: ${errText}`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n\n');
            buffer = lines.pop() || '';

            for (const block of lines) {
                if (!block.trim()) continue;
                let eventType = 'message';
                let dataStr = '';

                for (const line of block.split('\n')) {
                    if (line.startsWith('event:')) {
                        eventType = line.replace('event:', '').trim();
                    } else if (line.startsWith('data:')) {
                        dataStr = line.replace('data:', '').trim();
                    }
                }

                if (!dataStr) continue;

                try {
                    const parsedData = JSON.parse(dataStr);
                    if (eventType === 'swarm_event') {
                        yield { type: 'event', event: parsedData };
                    } else if (eventType === 'swarm_stage') {
                        yield { type: 'stage', stagePayload: parsedData };
                    } else if (eventType === 'swarm_complete') {
                        yield { type: 'complete', finalAnalysis: parsedData.finalAnalysis };
                    } else if (eventType === 'swarm_error') {
                        const errMsg = parsedData.error || 'Swarm remote error';
                        yield {
                            type: 'error',
                            error: errMsg,
                            finalAnalysis: { ui_title: 'Execution Error', error: errMsg }
                        };
                    }
                } catch {
                    // ignore unparseable chunk
                }
            }
        }
    }

    /**
     * Memory Cortex access for continuous cross-app knowledge retrieval, few-shot distillation, and portable backups.
     */
    get memory() {
        return {
            store: (content: string, metadata?: MemoryMetadata) => this.cortex.store(content, { appId: this.appId, ...metadata }),
            retrieve: (query: string, options?: RetrievalOptions) => this.cortex.retrieve(query, { appId: this.appId, ...options }),
            retrieveExemplars: (task: string, options?: RetrievalOptions) => this.cortex.retrieveExemplars(task, { appId: this.appId, ...options }),
            exportSnapshot: (options?: ExportMemoriesOptions) => options?.format === 'json' ? this.cortex.exportJson({ appId: this.appId, ...options }) : (options?.format === 'jsonl' ? this.cortex.exportJsonl({ appId: this.appId, ...options }) : this.cortex.exportMemories({ appId: this.appId, ...options })),
            exportJson: (options?: ExportMemoriesOptions) => this.cortex.exportJson({ appId: this.appId, ...options }),
            exportJsonl: (options?: ExportMemoriesOptions) => this.cortex.exportJsonl({ appId: this.appId, ...options }),
            importSnapshot: (snapshot: MemorySnapshot | string, options?: ImportMemoriesOptions) => this.cortex.importMemories(snapshot, { targetAppId: this.appId, ...options }),
            saveToFile: (filePath?: string) => this.cortex.saveToFile(filePath),
            loadFromFile: (filePath?: string, options?: ImportMemoriesOptions) => this.cortex.loadFromFile(filePath, { targetAppId: this.appId, ...options }),
            consolidate: () => this.cortex.consolidateMemories({ appId: this.appId })
        };
    }

    /**
     * Diagnostic health check for the runtime or remote server.
     */
    async health(): Promise<{ status: string; mode: string; isQdrantAvailable: boolean; uptime?: number }> {
        if (this.mode === 'remote') {
            try {
                const res = await fetch(`${this.serverUrl}/api/health`);
                if (res.ok) {
                    const data: any = await res.json();
                    return { status: 'ok', mode: 'remote', isQdrantAvailable: true, uptime: data.uptime };
                }
            } catch {
                return { status: 'unreachable', mode: 'remote', isQdrantAvailable: false };
            }
        }

        return {
            status: 'ok',
            mode: 'embedded',
            isQdrantAvailable: this.cortex.isQdrantAvailable
        };
    }
}

/**
 * Creates and initializes a portable SwarmClient instance for a target application.
 */
export function createSwarmClient(config: SwarmClientConfig = {}): SwarmClient {
    return new SwarmClient(config);
}
