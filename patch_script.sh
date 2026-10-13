#!/bin/bash
# 1. appAuth.ts
sed -i 's/const required = source.SWARM_AUTH_REQUIRED === '"'true'"' || tokens.size > 0;/const disabled = source.SWARM_AUTH_DISABLED === '"'true'"' \&\& source.NODE_ENV !== '"'production'"';\n    const required = !disabled;/g' src/swarm/server/appAuth.ts
sed -i 's/return c.json({ error: '"'Swarm auth is required but SWARM_APP_TOKENS is not configured'"' }, 503);/return c.json({ error: '"'auth not configured'"' }, 503);/g' src/swarm/server/appAuth.ts

# 2. appAuth.test.ts
cat << 'TESTEOF' > src/swarm/server/appAuth.test.ts
import { describe, expect, it } from 'vitest';
import { parseAppTokens, resolveCaller, tokensEqual, createAppAuthMiddleware } from './appAuth.ts';

describe('app auth tokens', () => {
    it('parses comma-separated app tokens', () => {
        const tokens = parseAppTokens('duelodds:secret-one,perfect-swarm:secret-two');
        expect(tokens.get('duelodds')).toBe('secret-one');
        expect(tokens.get('perfect-swarm')).toBe('secret-two');
    });

    it('parses a JSON token map', () => {
        const tokens = parseAppTokens('{"duelodds":"a:b","fantasy":"c"}');
        expect(tokens.get('duelodds')).toBe('a:b');
        expect(tokens.get('fantasy')).toBe('c');
    });

    it('identifies the caller without caring about the requested namespace', () => {
        const tokens = parseAppTokens('duelodds:secret-one,perfect-swarm:secret-two');
        expect(resolveCaller('Bearer secret-one', tokens)).toEqual({ appId: 'duelodds' });
        expect(resolveCaller('Bearer wrong', tokens)).toBeNull();
        expect(resolveCaller(undefined, tokens)).toBeNull();
    });

    it('compares tokens without matching a prefix', () => {
        expect(tokensEqual('secret', 'secret')).toBe(true);
        expect(tokensEqual('secret', 'secret-extra')).toBe(false);
    });
});

describe('app auth middleware scope', () => {
    const runMiddleware = async (middleware: any, path: string, authorization?: string, env?: any) => {
        const c: any = {
            req: { method: 'GET', path, header: (name: string) => authorization },
            env: env || {},
            json: (body: unknown, status: number) => ({ body, status }),
            set: () => undefined
        };
        let nextCalled = false;
        const result = await middleware(c, async () => { nextCalled = true; });
        return { nextCalled, result };
    };

    it('lets the dashboard load and still blocks API routes', async () => {
        const previous = process.env.SWARM_APP_TOKENS;
        process.env.SWARM_APP_TOKENS = 'perfect-swarm:secret';
        process.env.NODE_ENV = 'production';
        const middleware = createAppAuthMiddleware();

        expect((await runMiddleware(middleware, '/')).nextCalled).toBe(true);
        expect((await runMiddleware(middleware, '/assets/index.js')).nextCalled).toBe(true);
        expect((await runMiddleware(middleware, '/api/health')).nextCalled).toBe(true);
        expect((await runMiddleware(middleware, '/api/swarm/metrics')).nextCalled).toBe(false);
        expect((await runMiddleware(middleware, '/api/swarm/metrics', 'Bearer secret')).nextCalled).toBe(true);
        if (previous === undefined) delete process.env.SWARM_APP_TOKENS;
        else process.env.SWARM_APP_TOKENS = previous;
    });

    it('enforces fail-closed rules correctly', async () => {
        const middleware = createAppAuthMiddleware();

        // production + no env -> /api/swarm/analyze 503, /api/health 200
        let res = await runMiddleware(middleware, '/api/swarm/analyze', undefined, { NODE_ENV: 'production' });
        expect(res.nextCalled).toBe(false);
        expect(res.result).toEqual({ body: { error: 'auth not configured' }, status: 503 });

        res = await runMiddleware(middleware, '/api/health', undefined, { NODE_ENV: 'production' });
        expect(res.nextCalled).toBe(true);

        // production + tokens + no header -> 401
        res = await runMiddleware(middleware, '/api/swarm/analyze', undefined, { NODE_ENV: 'production', SWARM_APP_TOKENS: 'app:secret' });
        expect(res.nextCalled).toBe(false);
        expect(res.result).toEqual({ body: { error: 'Unauthorized' }, status: 401 });

        // production + valid token -> 200 (next called)
        res = await runMiddleware(middleware, '/api/swarm/analyze', 'Bearer secret', { NODE_ENV: 'production', SWARM_APP_TOKENS: 'app:secret' });
        expect(res.nextCalled).toBe(true);

        // production + SWARM_AUTH_DISABLED=true -> still enforced (503 without tokens)
        res = await runMiddleware(middleware, '/api/swarm/analyze', undefined, { NODE_ENV: 'production', SWARM_AUTH_DISABLED: 'true' });
        expect(res.nextCalled).toBe(false);
        expect(res.result).toEqual({ body: { error: 'auth not configured' }, status: 503 });

        // NODE_ENV=development + SWARM_AUTH_DISABLED=true -> allowed
        res = await runMiddleware(middleware, '/api/swarm/analyze', undefined, { NODE_ENV: 'development', SWARM_AUTH_DISABLED: 'true' });
        expect(res.nextCalled).toBe(true);

        // development + no flag + no tokens -> 503
        res = await runMiddleware(middleware, '/api/swarm/analyze', undefined, { NODE_ENV: 'development' });
        expect(res.nextCalled).toBe(false);
        expect(res.result).toEqual({ body: { error: 'auth not configured' }, status: 503 });
    });
});
TESTEOF

# 3. server.ts boot validation and logging
sed -i "s/import { getOrCreateDefaultCortex } from '.\/src\/swarm\/engine\/cortex.ts';/import { getOrCreateDefaultCortex } from '.\/src\/swarm\/engine\/cortex.ts';\nimport { fetchProviderModels } from '.\/src\/swarm\/server\/modelsProvider.ts';/g" server.ts
sed -i "s/const isProd = process.env.NODE_ENV === \"production\";/const isProd = process.env.NODE_ENV === \"production\";\n\n  if (isProd \&\& !process.env.SWARM_APP_TOKENS) {\n    console.error('ERROR: NODE_ENV is production but SWARM_APP_TOKENS is not set. All protected routes will fail closed (503).');\n  } else if (!isProd \&\& process.env.SWARM_AUTH_DISABLED === 'true') {\n    console.warn('WARNING: SWARM_AUTH_DISABLED is set. Authentication is disabled for development.');\n  }\n\n  const envVars = process.env;\n  if (envVars.GEMINI_API_KEY) fetchProviderModels('gemini', undefined, envVars).catch(() => {});\n  if (envVars.GROQ_API_KEY) fetchProviderModels('groq', undefined, envVars).catch(() => {});\n  if (envVars.OPENROUTER_API_KEY) fetchProviderModels('openrouter', undefined, envVars).catch(() => {});\n/g" server.ts

# 4. Model replacements
sed -i 's/mixtral-8x7b-32768/llama-3.3-70b-versatile/g' src/components/optimization/useOptimizationRunner.ts src/swarm/benchmark.ts src/swarm/router-lifecycle.test.ts src/swarm/router.ts src/swarm/router.test.ts src/swarm/agent.ts src/components/AgentConfigurator.tsx src/components/AgentConfigurator.test.tsx test-portable-swarm.ts test-multi-app-simulation.ts README.md src/components/SettingsModal.test.tsx
sed -i 's/gemma2-9b-it/llama-3.1-8b-instant/g' src/components/optimization/useOptimizationRunner.ts src/swarm/benchmark.ts src/swarm/router-lifecycle.test.ts src/swarm/router.ts src/swarm/router.test.ts src/swarm/agent.ts src/components/AgentConfigurator.tsx src/components/AgentConfigurator.test.tsx test-portable-swarm.ts test-multi-app-simulation.ts README.md src/components/SettingsModal.test.tsx
sed -i 's/deepseek\/deepseek-r1:free/nvidia\/nemotron-3-super-120b-a12b:free/g' src/components/optimization/useOptimizationRunner.ts src/swarm/benchmark.ts src/swarm/router-lifecycle.test.ts src/swarm/router.ts src/swarm/router.test.ts src/swarm/agent.ts src/components/AgentConfigurator.tsx src/components/AgentConfigurator.test.tsx test-portable-swarm.ts test-multi-app-simulation.ts README.md src/components/SettingsModal.test.tsx
sed -i 's/deepseek\/deepseek-r1/nvidia\/nemotron-3-super-120b-a12b:free/g' src/components/optimization/useOptimizationRunner.ts src/swarm/benchmark.ts src/swarm/router-lifecycle.test.ts src/swarm/router.ts src/swarm/router.test.ts src/swarm/agent.ts src/components/AgentConfigurator.tsx src/components/AgentConfigurator.test.tsx test-portable-swarm.ts test-multi-app-simulation.ts README.md src/components/SettingsModal.test.tsx
sed -i 's/deepseek-r1/nvidia\/nemotron-3-super-120b-a12b:free/g' src/components/optimization/useOptimizationRunner.ts src/swarm/benchmark.ts src/swarm/router-lifecycle.test.ts src/swarm/router.ts src/swarm/router.test.ts src/swarm/agent.ts src/components/AgentConfigurator.tsx src/components/AgentConfigurator.test.tsx test-portable-swarm.ts test-multi-app-simulation.ts README.md src/components/SettingsModal.test.tsx
sed -i 's/google\/gemini-flash-1.5/google\/gemma-4-31b-it:free/g' src/components/optimization/useOptimizationRunner.ts src/swarm/benchmark.ts src/swarm/router-lifecycle.test.ts src/swarm/router.ts src/swarm/router.test.ts src/swarm/agent.ts src/components/AgentConfigurator.tsx src/components/AgentConfigurator.test.tsx test-portable-swarm.ts test-multi-app-simulation.ts README.md src/components/SettingsModal.test.tsx
sed -i 's/gemini-flash-1.5/google\/gemma-4-31b-it:free/g' src/components/optimization/useOptimizationRunner.ts src/swarm/benchmark.ts src/swarm/router-lifecycle.test.ts src/swarm/router.ts src/swarm/router.test.ts src/swarm/agent.ts src/components/AgentConfigurator.tsx src/components/AgentConfigurator.test.tsx test-portable-swarm.ts test-multi-app-simulation.ts README.md src/components/SettingsModal.test.tsx

# Make sure we don't have duplicate free suffixes due to generic replace
sed -i 's/:free:free/:free/g' src/components/optimization/useOptimizationRunner.ts src/swarm/benchmark.ts src/swarm/router-lifecycle.test.ts src/swarm/router.ts src/swarm/router.test.ts src/swarm/agent.ts src/components/AgentConfigurator.tsx src/components/AgentConfigurator.test.tsx test-portable-swarm.ts test-multi-app-simulation.ts README.md src/components/SettingsModal.test.tsx
sed -i 's/nvidia\/nemotron-3-super-120b-a12b:free-free/nvidia\/nemotron-3-super-120b-a12b:free/g' test-multi-app-simulation.ts README.md test-portable-swarm.ts

# 5. Agent Failover Logic
sed -i "s/errMsg.includes('403') ||/errMsg.includes('402') ||\n                        errMsg.includes('403') ||\n                        errMsg.includes('model_decommissioned') ||/g" src/swarm/agent.ts

# 6. server.test.ts Auth Stubbing
sed -i "s/import { describe, it, expect, beforeEach, afterEach } from 'vitest';/import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';/g" src/swarm/server.test.ts
sed -i "s/    beforeEach(async () => {/    beforeEach(async () => {\n        vi.stubEnv('SWARM_APP_TOKENS', 'test-app:test-token-123');/g" src/swarm/server.test.ts
sed -i "s/        if (server) {/        vi.unstubAllEnvs();\n        if (server) {/g" src/swarm/server.test.ts

# Fix failing tests due to auth
sed -i "s/fetch(\`\${baseUrl}\/api\/swarm\/calibrate?appId=test-app\`)/fetch(\`\${baseUrl}\/api\/swarm\/calibrate?appId=test-app\`, { headers: { 'Authorization': 'Bearer test-token-123' } })/g" src/swarm/server.test.ts
sed -i "s/headers: { 'Content-Type': 'application\/json' },/headers: { 'Content-Type': 'application\/json', 'Authorization': 'Bearer test-token-123' },/g" src/swarm/server.test.ts
sed -i "s/fetch(\`\${baseUrl}\/api\/does-not-exist\`)/fetch(\`\${baseUrl}\/api\/does-not-exist\`, { headers: { 'Authorization': 'Bearer test-token-123' } })/g" src/swarm/server.test.ts
sed -i "s/'x-provider-key': 'attacker-key'/'x-provider-key': 'attacker-key',\n                'Authorization': 'Bearer test-token-123'/g" src/swarm/server.test.ts
sed -i "s/headers: {/headers: {\n                'Authorization': 'Bearer test-token-123',/g" src/swarm/server.test.ts
# Clean up duplicate Authorization
sed -i "s/'Authorization': 'Bearer test-token-123',\n                'Authorization': 'Bearer test-token-123',/'Authorization': 'Bearer test-token-123',/g" src/swarm/server.test.ts
sed -i "s/headers: {\n                'Authorization': 'Bearer test-token-123',\n                    'Content-Type': 'application\/json',\n                    'Authorization': 'Bearer test-token'/headers: {\n                    'Content-Type': 'application\/json',\n                    'Authorization': 'Bearer test-token'/g" src/swarm/server.test.ts
