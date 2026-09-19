import { Hono } from 'hono';
import { serve } from '@hono/node-server';

const app = new Hono();
app.get('/', (c) => {
    return c.json({
        hasEnv: !!c.env,
        envKeys: c.env ? Object.keys(c.env) : [],
        processEnvGroq: !!process.env.GROQ_API_KEY,
    });
});

serve({ fetch: app.fetch, port: 3001 }, () => {
    console.log('Server running on port 3001');
});
