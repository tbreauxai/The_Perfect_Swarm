import { getRequestListener } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createServer as createNodeServer } from 'node:http';
import { createServer as createViteServer } from 'vite';
import { Hono } from 'hono';
import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { createSwarmServer } from './src/swarm/server.ts';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const port = Number(process.env.PORT) || 3000;
  
  const defaultAi = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY || 'MISSING_KEY'
  });

  // 1. Create the Edge-compatible Swarm API
  const swarmApi = createSwarmServer({
      defaultAi,
      cors: true
  });

  // 2. Create the main wrapper app
  const app = new Hono();

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

  // Global Error handling
  app.onError((err, c) => {
    console.error('Global Error:', err);
    return c.json({ error: err.message || 'Internal Server Error' }, 500);
  });

  // 3. Setup Vite & Node HTTP Server
  const honoListener = getRequestListener(app.fetch);

  if (process.env.NODE_ENV !== "production") {
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
    const distPath = path.join(process.cwd(), 'dist');
    
    // Serve static files via Hono in production
    app.use('/assets/*', serveStatic({ root: './dist' }));
    app.use('/*', serveStatic({ root: './dist', path: 'index.html' }));

    const server = createNodeServer(honoListener);
    server.listen(port, "0.0.0.0", () => {
      console.log(`Production Server running on port ${port} (Hono)`);
    });
  }
}

startServer();
