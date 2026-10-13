const fs = require('fs');
let code = fs.readFileSync('src/server.test.ts', 'utf8');

code = code.replace(
  "import { describe, it, expect, beforeAll } from 'vitest';",
  "import { describe, it, expect, beforeAll, vi, afterAll } from 'vitest';"
);

code = code.replace(
  "    const app = createMainApp({",
  "    beforeAll(() => { vi.stubEnv('SWARM_APP_TOKENS', 'test-app:test-token-123'); });\n    afterAll(() => { vi.unstubAllEnvs(); });\n\n    const app = createMainApp({"
);

code = code.replace(
  "        const res = await app.request('/api/does-not-exist');",
  "        const res = await app.request('/api/does-not-exist', {\n            headers: { 'Authorization': 'Bearer test-token-123' }\n        });"
);

code = code.replace(
  "        const res = await app.request('/api/config/status');",
  "        const res = await app.request('/api/config/status', {\n            headers: { 'Authorization': 'Bearer test-token-123' }\n        });"
);

code = code.replace(
  "        const res = await app.request('/api/config/status');",
  "        const res = await app.request('/api/config/status', {\n            headers: { 'Authorization': 'Bearer test-token-123' }\n        });"
);

fs.writeFileSync('src/server.test.ts', code);
