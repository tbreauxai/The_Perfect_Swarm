import type { Hono } from 'hono';
import type { ServerType } from '@hono/node-server';
import type { GoogleGenAI } from '@google/genai';
import type { MemoryCortex } from '../memory.ts';

export interface SwarmServerOptions {
    port?: number;
    host?: string;
    defaultSettings?: any;
    defaultAi?: GoogleGenAI;
    defaultCortex?: MemoryCortex;
    cors?: boolean;
}

export interface SwarmServerApp extends Hono {
    listen(port?: number | ((...args: any[]) => void), hostnameOrCb?: string | ((...args: any[]) => void), cb?: (...args: any[]) => void): ServerType;
    address(): any;
    close(cb?: (err?: Error) => void): any;
}
