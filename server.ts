import express from 'express';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { executeSwarmWorkflow } from './src/services/swarmEngine.ts';
import { handleSwarmSse } from './src/swarm/server.ts';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const port = process.env.PORT || 3000;

  app.use(express.json({ limit: '100mb' }));
  app.use(express.urlencoded({ limit: '100mb', extended: true }));

  const defaultAi = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY || 'MISSING_KEY'
  });

  app.get('/api/config/status', (req, res) => {
    res.json({
      hasGeminiKey: !!process.env.GEMINI_API_KEY,
      hasGroqKey: !!process.env.GROQ_API_KEY,
      hasOpenRouterKey: !!process.env.OPENROUTER_API_KEY,
      hasMistralKey: !!process.env.MISTRAL_API_KEY,
      hasQdrantUrl: !!process.env.QDRANT_URL,
      hasQdrantKey: !!process.env.QDRANT_API_KEY
    });
  });

  app.post('/api/swarm/analyze', async (req, res) => {
    try {
      const { task, data, settings, enableDeepAnalysis, complexityOverride } = req.body;
      
      const hasUserKeys = settings?.geminiApiKey || settings?.groqApiKey || settings?.openRouterApiKey || settings?.githubToken || settings?.mistralApiKey;
      const hasEnvKeys = !!process.env.GEMINI_API_KEY || !!process.env.OPENROUTER_API_KEY || !!process.env.GROQ_API_KEY || !!process.env.MISTRAL_API_KEY || !!process.env.GITHUB_TOKEN;

      if (!hasUserKeys && !hasEnvKeys) {
        return res.status(401).json({ error: 'No AI API keys provided in environment or settings.' });
      }

      if (!task) {
        return res.status(400).json({ error: 'Task is required.' });
      }

      const forceFullSwarm = req.body.forceFullSwarm ?? req.body.settings?.forceFullSwarm ?? req.body.settings?.disableFastPath;

      const result = await executeSwarmWorkflow({
        task,
        data,
        settings,
        defaultAi,
        enableDeepAnalysis: enableDeepAnalysis ?? settings?.enableDeepAnalysis,
        forceFullSwarm,
        complexityOverride
      });

      res.json(result);
    } catch (error: any) {
      console.error("Swarm Error:", error);
      res.status(500).json({ error: error.message || 'Internal Server Error' });
    }
  });

  app.all('/api/swarm/stream', async (req, res) => {
    try {
      const task = (req.method === 'POST' ? req.body.task : req.query.task) as string;
      const data = (req.method === 'POST' ? req.body.data : req.query.data) as string;
      const settings = (req.method === 'POST' ? req.body.settings : {}) || {};
      const enableDeepAnalysis = req.method === 'POST' ? req.body.enableDeepAnalysis : req.query.enableDeepAnalysis === 'true';
      const forceFullSwarm = req.method === 'POST'
        ? (req.body.forceFullSwarm ?? req.body.settings?.forceFullSwarm ?? req.body.settings?.disableFastPath)
        : (req.query.forceFullSwarm === 'true' || req.query.disableFastPath === 'true');
      const complexityOverride = req.method === 'POST' ? req.body.complexityOverride : req.query.complexityOverride;

      if (!task) {
        return res.status(400).json({ error: 'Task is required.' });
      }

      await handleSwarmSse(req, res, {
        task,
        data,
        settings,
        defaultAi,
        enableDeepAnalysis,
        forceFullSwarm,
        complexityOverride
      });
    } catch (error: any) {
      console.error("Swarm Stream Error:", error);
      if (!res.headersSent) {
        res.status(500).json({ error: error.message || 'Internal Server Error' });
      }
    }
  });

  // Global error handler
  app.use((err: any, req: any, res: any, next: any) => {
    console.error('Express Global Error:', err);
    if (err instanceof SyntaxError && 'body' in err) {
      return res.status(400).json({ error: 'Invalid JSON payload. ' + err.message });
    }
    if (err.type === 'entity.too.large') {
      return res.status(413).json({ error: 'Payload too large. Try reducing the size of your input data.' });
    }
    res.status(err.status || 500).json({ error: err.message || 'Internal Server Error' });
  });

  // Vite development / production middleware
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(Number(port), "0.0.0.0", () => {
    console.log(`Server running on port ${port}`);
  });
}

startServer();
