import { getRequestListener } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createServer as createNodeServer } from 'node:http';
import { createServer as createViteServer } from 'vite';
import { Hono } from 'hono';
import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'node:fs';
import { fileURLToPath } from 'url';
import { createSwarmServer } from './src/swarm/server.ts';
import { createCorsMiddleware } from './src/swarm/server/cors.ts';
import { createAppAuthMiddleware } from './src/swarm/server/appAuth.ts';
import { getOrCreateDefaultCortex } from './src/swarm/engine/cortex.ts';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function createMainApp(options: { defaultAi?: any; defaultCortex?: any; serveStatic?: boolean } = {}) {
  const defaultAi = options.defaultAi || new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY || 'MISSING_KEY'
  });

  // 1. Create the Edge-compatible Swarm API
  const defaultCortex = options.defaultCortex || getOrCreateDefaultCortex('perfect-swarm', defaultAi);
  const swarmApi = createSwarmServer({
      defaultAi,
      defaultCortex,
      cors: true
  });

  // 2. Create the main wrapper app
  const app = new Hono();

  // Apply security headers to every response (including static files & HTML)
  app.use('*', async (c, next) => {
    c.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https://the-perfect-swarm.onrender.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    c.header('X-Frame-Options', 'DENY');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    await next();
  });

  // Mount CORS ahead of auth so 401/404/413/500 carry ACAO
  app.use('*', createCorsMiddleware());

  app.use('*', createAppAuthMiddleware());

  app.get('/api/config/status', (c) => {
    return c.json({
      hasGeminiKey: !!process.env.GEMINI_API_KEY,
      hasGroqKey: !!process.env.GROQ_API_KEY,
      hasOpenRouterKey: !!process.env.OPENROUTER_API_KEY,
      hasMistralKey: !!process.env.MISTRAL_API_KEY,
      hasQdrantUrl: !!process.env.QDRANT_URL,
      hasQdrantKey: !!process.env.QDRANT_API_KEY
    });
  });

  // Mount the Swarm API
  app.route('/', swarmApi);

  // Return JSON 404 for any unmatched /api/* requests so they never fall back to index.html
  app.all('/api/*', (c) => {
    return c.json({ error: 'Not found' }, 404);
  });

  // Global Error handling
  app.onError((err, c) => {
    console.error('Global Error:', err);
    return c.json({ error: err.message || 'Internal Server Error' }, 500);
  });

  if (options.serveStatic) {
    mountStaticHandlers(app);
  }

  return app;
}

export function mountStaticHandlers(app: Hono, distDir = './dist') {
  if ((app as any).__staticHandlersMounted) return;
  (app as any).__staticHandlersMounted = true;

  const distStatic = serveStatic({ root: distDir });

  // Keep /assets/*
  app.use('/assets/*', serveStatic({ root: distDir }));

  // Serve root static files from dist with correct content types
  app.use('*', async (c, next) => {
    const reqPath = c.req.path;
    if (reqPath !== '/' && reqPath !== '/index.html' && !reqPath.startsWith('/api/')) {
      const target = path.join(process.cwd(), distDir, reqPath);
      if (fs.existsSync(target) && fs.statSync(target).isFile()) {
        return distStatic(c, next);
      }
    }
    await next();
  });

  // Shell fallback: GET/HEAD only for / and /index.html
  app.get('/', serveStatic({ root: distDir, path: 'index.html' }));
  app.get('/index.html', serveStatic({ root: distDir, path: 'index.html' }));

  // Other non-API non-asset paths return 404 HTML
  app.get('*', (c) => {
    return c.html('<!DOCTYPE html><html><head><title>404 Not Found</title></head><body><h1>404 Not Found</h1></body></html>', 404);
  });
}

async function startServer() {
  const port = Number(process.env.PORT) || 3000;
  
  const defaultAi = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY || 'MISSING_KEY'
  });
  const defaultCortex = getOrCreateDefaultCortex('perfect-swarm', defaultAi);

  const isProd = process.env.NODE_ENV === "production";
  const app = createMainApp({ defaultAi, defaultCortex, serveStatic: isProd });

  // 3. Setup Vite & Node HTTP Server
  const honoListener = getRequestListener(app.fetch);

  if (!isProd) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });

    const server = createNodeServer((req, res) => {
      // Route API requests to Hono
      if (req.url?.startsWith('/api')) {
        honoListener(req, res);
      } else {
        // Route frontend requests to Vite
        vite.middlewares(req, res, () => {
          res.statusCode = 404;
          res.end('Not found');
        });
      }
    });

    server.listen(port, "0.0.0.0", () => {
      console.log(`Development Server running on port ${port} (Vite + Hono)`);
    });

  } else {
    mountStaticHandlers(app);

    const server = createNodeServer(honoListener);
    server.listen(port, "0.0.0.0", () => {
      console.log(`Production Server running on port ${port} (Hono)`);
    });
  }
}

if (process.argv[1] && (process.argv[1].endsWith('server.ts') || process.argv[1].endsWith('server.js'))) {
  startServer();
}
