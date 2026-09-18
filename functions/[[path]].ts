import { handle } from 'hono/cloudflare-pages';
import { createSwarmServer } from '../src/swarm/server.ts';
import { GoogleGenAI } from '@google/genai';

// In a Cloudflare Pages Function environment, process.env is replaced by `env` passed to the request.
// However, when initialized outside the request, we can retrieve them from the Hono context or rely on global bindings.
// For now, we will initialize the app lazily or pass a dynamic provider if needed.
// Actually, it is safer to just create the server and rely on environment bindings inside the routes.

let aiInstance: GoogleGenAI | undefined;

const app = createSwarmServer({
    // We can lazily initialize the default AI inside the router using context environment bindings if needed,
    // but for now, we leave defaultAi undefined so it falls back to the user-provided keys in the settings object,
    // or we can initialize it here if globalEnv exists.
    cors: true
});

// Cloudflare Pages expects an `onRequest` handler for [[path]].ts which acts as a catch-all route.
export const onRequest = handle(app);
