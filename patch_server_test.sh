sed -i "s/const app = createMainApp({/const app = createMainApp({\n        defaultAi: {\n            apiKey: 'mock-test-key'\n        }\n    });\n    app.use('*', (c, next) => {\n        c.env = { SWARM_APP_TOKENS: 'test-app:test-token-123' };\n        return next();\n    });/g" src/server.test.ts

# Wait, `app` in `src/server.test.ts` doesn't take Hono context directly, but setting env var should work.
