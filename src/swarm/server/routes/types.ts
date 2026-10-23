import type { MemoryCortex } from '../../memory/index.ts';

export interface ServerRouteContext {
    defaultSettings: Record<string, any>;
    defaultAi?: any;
    defaultCortex?: MemoryCortex;
    swarmBodyLimit: any;
}
