const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf-8');

const newEndpoint = `
app.get('/api/config/status', (req, res) => {
  res.json({
    hasGeminiKey: !!process.env.GEMINI_API_KEY,
    hasGroqKey: !!process.env.GROQ_API_KEY,
    hasOpenRouterKey: !!process.env.OPENROUTER_API_KEY,
    hasQdrantUrl: !!process.env.QDRANT_URL,
    hasQdrantKey: !!process.env.QDRANT_API_KEY
  });
});

app.post('/api/swarm/analyze', async (req, res) => {`;

code = code.replace(`app.post('/api/swarm/analyze', async (req, res) => {`, newEndpoint);

fs.writeFileSync('server.ts', code);
