#!/usr/bin/env node
/**
 * Deterministic Architecture Map Generator for The_Perfect_Swarm.
 * Scans src/ and root server/config files to produce docs/ARCHITECTURE_MAP.md.
 * Zero timestamps, deterministic sorting, no raw code dumps or brittle line numbers.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const OUT_FILE = path.join(ROOT, 'docs', 'ARCHITECTURE_MAP.md');

function toPosix(p) {
  return p.split(path.sep).join('/');
}

function readText(relPath) {
  const full = path.join(ROOT, relPath);
  if (!fs.existsSync(full)) return '';
  return fs.readFileSync(full, 'utf8');
}

function walkFiles(dirRel, options = {}) {
  const { excludeDirs = new Set(), includeExts = new Set(['.ts', '.tsx', '.js', '.mjs']) } = options;
  const start = path.join(ROOT, dirRel);
  if (!fs.existsSync(start)) return [];
  const results = [];

  function visit(current) {
    const entries = fs.readdirSync(current, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      const rel = toPosix(path.relative(ROOT, full));
      if (entry.isDirectory()) {
        if (excludeDirs.has(entry.name) || excludeDirs.has(rel)) continue;
        visit(full);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name);
        if (!includeExts.has(ext)) continue;
        if (/\.(test|spec|bench)\.[cm]?[jt]sx?$/i.test(entry.name)) continue;
        results.push(rel);
      }
    }
  }

  visit(start);
  return results.sort((a, b) => a.localeCompare(b));
}

function extractExports(content) {
  const functions = new Set();
  const classes = new Set();
  const constants = new Set();
  const types = new Set();
  const reexports = new Set();

  const fnRe = /^\s*export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm;
  const clsRe = /^\s*export\s+(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/gm;
  const constRe = /^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm;
  const typeRe = /^\s*export\s+(?:type|interface|enum)\s+([A-Za-z_$][\w$]*)/gm;
  const reexpRe = /^\s*export\s+\*\s+from\s+['"]([^'"]+)['"]/gm;

  let m;
  while ((m = fnRe.exec(content)) !== null) functions.add(m[1]);
  while ((m = clsRe.exec(content)) !== null) classes.add(m[1]);
  while ((m = constRe.exec(content)) !== null) constants.add(m[1]);
  while ((m = typeRe.exec(content)) !== null) types.add(m[1]);
  while ((m = reexpRe.exec(content)) !== null) reexports.add(m[1]);

  return {
    functions: [...functions].sort(),
    classes: [...classes].sort(),
    constants: [...constants].sort(),
    types: [...types].sort(),
    reexports: [...reexports].sort(),
  };
}

function extractRoutes(relFiles) {
  const routes = [];
  const seen = new Set();
  const routeRe = /\bapp\.(get|post|put|delete|patch|all)\(\s*['"]([^'"]+)['"]/g;

  for (const rel of relFiles) {
    const content = readText(rel);
    let m;
    while ((m = routeRe.exec(content)) !== null) {
      const method = m[1].toUpperCase();
      const routePath = m[2];
      const key = `${method} ${routePath} (${rel})`;
      if (!seen.has(key)) {
        seen.add(key);
        routes.push({ method, path: routePath, file: rel });
      }
    }
  }
  return routes.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

function extractNumberConst(content, name, fallback) {
  const re = new RegExp(`export\\s+const\\s+${name}\\s*=\\s*([^;\\n]+)`);
  const m = re.exec(content);
  return m ? m[1].trim() : fallback;
}

function extractStringArrayConst(content, name) {
  const re = new RegExp(`export\\s+const\\s+${name}\\s*=\\s*\\[([\\s\\S]*?)\\]`);
  const m = re.exec(content);
  if (!m) return [];
  return [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]);
}

function extractProviderAdapters(registryContent) {
  const matches = [...registryContent.matchAll(/new\s+([A-Za-z0-9_]+Adapter)\(\)/g)];
  return [...new Set(matches.map((m) => m[1]))].sort();
}

function extractRequiredQdrantIndexes(qdrantContent) {
  const block = /const\s+REQUIRED_INDEXES[^=]*=\s*\[([\s\S]*?)\];/.exec(qdrantContent);
  if (!block) return [];
  const items = [];
  const itemRe = /\{\s*field:\s*['"]([^'"]+)['"]\s*,\s*schema:\s*['"]([^'"]+)['"]\s*\}/g;
  let m;
  while ((m = itemRe.exec(block[1])) !== null) {
    items.push({ field: m[1], schema: m[2] });
  }
  return items;
}

function formatSymbolList(exp, maxItems = 10) {
  const parts = [];
  for (const c of exp.classes) parts.push(`\`class ${c}\``);
  for (const f of exp.functions) parts.push(`\`${f}()\``);
  for (const k of exp.constants) parts.push(`\`${k}\``);
  if (parts.length === 0 && exp.types.length > 0) {
    for (const t of exp.types.slice(0, 6)) parts.push(`\`type ${t}\``);
  }
  if (parts.length === 0 && exp.reexports.length > 0) {
    return `re-exports: ${exp.reexports.map((r) => `\`${r}\``).join(', ')}`;
  }
  if (parts.length === 0) return '_internal / side-effect module_';
  if (parts.length <= maxItems) return parts.join(', ');
  return `${parts.slice(0, maxItems).join(', ')}, _(+${parts.length - maxItems} more)_`;
}

function renderDomainInventory(title, files, maxItemsPerFile = 10) {
  const lines = [`### ${title}`, ''];
  if (files.length === 0) {
    lines.push('_No modules found._', '');
    return lines;
  }
  lines.push('| Module | Exported Symbols |');
  lines.push('| :--- | :--- |');
  for (const rel of files) {
    const exp = extractExports(readText(rel));
    lines.push(`| \`${rel}\` | ${formatSymbolList(exp, maxItemsPerFile)} |`);
  }
  lines.push('');
  return lines;
}

function buildArchitectureMap() {
  const allSrcFiles = walkFiles('src', { excludeDirs: new Set(['__repro__', 'node_modules']) });
  const rootFiles = ['server.ts', 'swarm.ts', 'package.json', 'wrangler.toml', 'tsconfig.json']
    .filter((f) => fs.existsSync(path.join(ROOT, f)));

  const serverRouteFiles = allSrcFiles.filter((f) => f.startsWith('src/swarm/server/'));
  const engineFiles = allSrcFiles.filter((f) => f.startsWith('src/swarm/engine/'));
  const toolFiles = allSrcFiles.filter((f) => f.startsWith('src/swarm/tools/'));
  const providerFiles = allSrcFiles.filter((f) => f.startsWith('src/swarm/providers/'));
  const memoryFiles = allSrcFiles.filter((f) => f.startsWith('src/swarm/memory/'));
  const facadeFiles = allSrcFiles.filter(
    (f) => /^src\/swarm\/[^/]+\.ts$/.test(f)
  );
  const uiFiles = allSrcFiles.filter(
    (f) => f.startsWith('src/components/') || f.startsWith('src/hooks/') || f.startsWith('src/services/')
  );

  const routes = extractRoutes(['server.ts', 'src/swarm/server/app.ts', ...serverRouteFiles]);

  const historyScopeSrc = readText('src/swarm/engine/historyScope.ts');
  const slimPayloadSrc = readText('src/swarm/server/slimPayload.ts');
  const limiterSrc = readText('src/swarm/providers/limiter.ts');
  const registrySrc = readText('src/swarm/providers/registry.ts');
  const sanitizerSrc = readText('src/swarm/memory/memorySanitizer.ts');
  const qdrantSrc = readText('src/swarm/memory/storage/qdrantStorage.ts');

  const maxGroups = extractNumberConst(historyScopeSrc, 'MAX_RETRIEVAL_GROUPS', '4');
  const maxEvents = extractNumberConst(historyScopeSrc, 'MAX_UNIQUE_EVENTS', '20');
  const maxEntities = extractNumberConst(historyScopeSrc, 'MAX_UNIQUE_ENTITIES', '40');
  const maxEnvBytes = extractNumberConst(historyScopeSrc, 'MAX_ENVELOPE_METADATA_BYTES', '4096');
  const maxReqIdLen = extractNumberConst(historyScopeSrc, 'MAX_REQUEST_ID_LENGTH', '128');
  const maxIdBytes = extractNumberConst(historyScopeSrc, 'MAX_ID_BYTE_LENGTH', '128');
  const maxSportBytes = extractNumberConst(historyScopeSrc, 'MAX_SPORT_BYTE_LENGTH', '64');
  const ctxSections = extractStringArrayConst(historyScopeSrc, 'HISTORY_CONTEXT_SECTIONS');
  const optSections = extractStringArrayConst(historyScopeSrc, 'HISTORY_OPTIONAL_CONTEXT');
  const purposes = extractStringArrayConst(historyScopeSrc, 'HISTORY_PURPOSES');
  const slimVersion = extractNumberConst(slimPayloadSrc, 'SLIM_PAYLOAD_VERSION', "'slim-v1'");
  const seedVersion = extractNumberConst(slimPayloadSrc, 'SEED_MANIFEST_VERSION', "'v2-seed'");

  const breakerThreshold = extractNumberConst(limiterSrc, 'BREAKER_FAILURE_THRESHOLD', '3');
  const breakerOpenMs = extractNumberConst(limiterSrc, 'BREAKER_OPEN_MS', '300000');
  const modelCooldownMs = extractNumberConst(limiterSrc, 'MODEL_COOLDOWN_MS', '60000');
  const timeoutCooldownMs = extractNumberConst(limiterSrc, 'MODEL_TIMEOUT_COOLDOWN_MS', '600000');
  const billingCooldownMs = extractNumberConst(limiterSrc, 'BILLING_COOLDOWN_MS', '1800000');
  const providerTimeoutMs = extractNumberConst(limiterSrc, 'PROVIDER_CALL_TIMEOUT_MS', '25000');
  const adapters = extractProviderAdapters(registrySrc);

  const defaultCollection = extractNumberConst(sanitizerSrc, 'DEFAULT_CORTEX_COLLECTION', "'pwa_swarm_dev_cortex_v4'");
  const legacyCollections = extractStringArrayConst(sanitizerSrc, 'LEGACY_CORTEX_COLLECTIONS');
  const qdrantIndexes = extractRequiredQdrantIndexes(qdrantSrc);

  const lines = [
    '# The_Perfect_Swarm — Architecture Map',
    '',
    '> **Auto-generated** by `node scripts/generate-architecture-map.mjs` (git-excluded via `.git/info/exclude`).',
    '> Do not edit manually; re-run the generator after adding, removing, or modifying modules, routes, tools, providers, or validators.',
    '',
    '## 1. Repository & Runtime Overview',
    '',
    `- **Root Entrypoints & Config**: ${rootFiles.map((f) => `\`${f}\``).join(', ')}`,
    `- **Source Footprint**: ${allSrcFiles.length} non-test source files under \`src/\` (${serverRouteFiles.length} server, ${engineFiles.length} engine, ${toolFiles.length} tools, ${providerFiles.length} providers, ${memoryFiles.length} memory, ${facadeFiles.length} swarm facades, ${uiFiles.length} UI/client).`,
    '- **Runtime Targets**: Node.js (`@hono/node-server` via `server.ts`) and Edge/Workers (`src/swarm/server/app.ts` + `wrangler.toml`).',
    '',
    '## 2. Service Topology & Request Flow',
    '',
    '```mermaid',
    'flowchart LR',
    '  Client["Caller / DuelOdds / UI"] --> Auth["CORS + AppAuth + 10MB BodyLimit"]',
    '  Auth --> Routes["/api/swarm/analyze & /api/swarm/stream (SSE)"]',
    '  Routes --> Scope["Envelope & Scope Validation (historyScope + slimPayload)"]',
    '  Scope --> Planner["Two-Hop Tool Planner (triagePlanner / seatToolLoop)"]',
    '  Planner --> Tools["Read-Only Tools (DuelOdds RPC + GameContext + Math/Stats)"]',
    '  Tools --> Seats["3 Specialist Seats (Analyst Execution)"]',
    '  Seats --> Compiler["GodView Compiler (synthesisPipeline)"]',
    '  Compiler --> Verifier["Deterministic Verifier (verificationPipeline)"]',
    '  Verifier --> Cortex["Qdrant Cortex Memory (MemoryCortex + RRF)"]',
    '```',
    '',
    '### End-to-End Request Stages',
    '',
    '1. **Ingress & Middleware (`server.ts`, `src/swarm/server/app.ts`)**: Security headers, CORS (`createCorsMiddleware`), app token auth (`createAppAuthMiddleware`), telemetry (`createTelemetryMiddleware`), and `10 MB` body limit (`swarmBodyLimit`) on analyze/stream/backtest routes.',
    '2. **Route Dispatch (`src/swarm/server/routes/analyze.ts`)**: `POST /api/swarm/analyze` (sync or async job via `globalAsyncJobs`) and `ALL /api/swarm/stream` (SSE via `handleSwarmSse`).',
    '3. **Envelope & Scope Validation (`src/swarm/engine/historyScope.ts`, `src/swarm/server/slimPayload.ts`)**: Validates `RetrievalContextEnvelope` (`version: 1`), `snapshotRefs`, `slim-v1` payloads, and `v2-seed` manifests; hydrates context from Supabase read-only store (`readGameContextFromStore`) or fails closed with HTTP `400`/`422`.',
    '4. **Two-Hop Tool Planner & Read-Only Tools (`src/swarm/engine/triagePlanner.ts`, `src/swarm/engine/seatToolLoop.ts`)**: Round 1 issues role-scoped read-only tool calls (parallelized with timeout/cache via `triageExecutor.ts`); Round 2 synthesizes with capped tool evidence (max 2 rounds, prefetch fallback on provider tool-use 400).',
    '5. **3 Specialist Seats + GodView Compiler (`src/swarm/engine/analystExecution.ts`, `src/swarm/engine/synthesisPipeline.ts`)**: Parallel specialist seats produce structured/guarded `AnalystResponse` outputs; `executeManagerSynthesis` compiles the unified GodView `ManagerResponse` within provider token ceilings.',
    '6. **Deterministic Verifier (`src/swarm/engine/verificationPipeline.ts`)**: Enforces `claimGrounding`, `criticAudit`, `marketRowBinding`, `injuryAttribution`, `pullBeforePass`, and `compilerProseSync` invariants before finalizing `picks`, `wageringPass`, and `criticApproved`.',
    '7. **Qdrant Cortex Memory (`src/swarm/memory/cortex.ts`, `src/swarm/memory/storage/qdrantStorage.ts`)**: Retrieves and consolidates lessons/episodes using 768-dim Gemini embeddings (with deterministic local fallback) + sparse vectors + RRF ranking (`rrfRanker.ts`).',
    '',
    '### HTTP & SSE Endpoints',
    '',
    '| Method | Path | Defined In |',
    '| :--- | :--- | :--- |',
    ...routes.map((r) => `| \`${r.method}\` | \`${r.path}\` | \`${r.file}\` |`),
    '',
    '## 3. Module & Exported Function Inventory',
    '',
    ...renderDomainInventory('Server & Routes (`src/swarm/server/`)', serverRouteFiles, 10),
    ...renderDomainInventory('Swarm Engine (`src/swarm/engine/`)', engineFiles, 8),
    ...renderDomainInventory('Read-Only & Built-in Tools (`src/swarm/tools/`)', toolFiles, 10),
    ...renderDomainInventory('LLM Providers & Rate Limiter (`src/swarm/providers/`)', providerFiles, 10),
    ...renderDomainInventory('Qdrant Cortex Memory (`src/swarm/memory/`)', memoryFiles, 8),
    ...renderDomainInventory('Top-Level Swarm Facades (`src/swarm/*.ts`)', facadeFiles, 8),
    '',
    '## 4. External Contracts & Validation Invariants',
    '',
    '### Envelope Byte Caps & Retrieval Scope (`src/swarm/engine/historyScope.ts`, `src/swarm/server/app.ts`)',
    '',
    `- **HTTP Payload Cap**: \`swarmBodyLimit\` = \`10 * 1024 * 1024\` bytes (10 MB) on \`/api/swarm/analyze\`, \`/api/swarm/stream\`, \`/api/swarm/backtest\`.`,
    `- **Envelope Metadata Cap**: \`MAX_ENVELOPE_METADATA_BYTES\` = \`${maxEnvBytes}\` bytes.`,
    `- **Scope Cardinality Caps**: \`MAX_RETRIEVAL_GROUPS\` = \`${maxGroups}\`, \`MAX_UNIQUE_EVENTS\` = \`${maxEvents}\`, \`MAX_UNIQUE_ENTITIES\` = \`${maxEntities}\`.`,
    `- **Identifier Length Caps**: \`MAX_REQUEST_ID_LENGTH\` = \`${maxReqIdLen}\`, \`MAX_ID_BYTE_LENGTH\` = \`${maxIdBytes}\`, \`MAX_SPORT_BYTE_LENGTH\` = \`${maxSportBytes}\`.`,
    `- **Allowed Purposes**: ${purposes.map((p) => `\`${p}\``).join(', ')}.`,
    `- **Required/Optional Context Sections**: ${ctxSections.map((s) => `\`${s}\``).join(', ')} (optional: ${optSections.map((s) => `\`${s}\``).join(', ')}).`,
    `- **Payload Versions**: \`SLIM_PAYLOAD_VERSION\` = \`${slimVersion}\`, \`SEED_MANIFEST_VERSION\` = \`${seedVersion}\`.`,
    '',
    '### `snapshotRef` Schema Rules (`src/swarm/engine/historyScope.ts`)',
    '',
    '- **Required Exact Keys**: `event_id`, `game_date`, `sport`, `snapshot_id`, `content_hash` (strict allowlist `ALLOWED_SNAPSHOT_REF_KEYS`; extra keys rejected with HTTP `400`).',
    '- **Field Formats**: `game_date` must match `YYYY-MM-DD`; `event_id`, `snapshot_id`, `content_hash` must be non-empty ASCII tokens (`<= 128` bytes); `sport` `<= 64` bytes.',
    '- **Store Enforcement**: Requests with `snapshotRefs`, `requiredContext`, `purpose` in `parlay | bet-chat`, or explicit retrieval context require `readGameContextFromStore` readiness; missing/ineligible context returns HTTP `422` (`slim_pull_failed`).',
    '',
    '### Read-Only Tool Signatures (`src/swarm/tools/`)',
    '',
    '| Tool Name | Module | Role / Purpose |',
    '| :--- | :--- | :--- |',
    '| `get_matchup_fundamentals` | `src/swarm/tools/dueloddsRpcTools.ts` | Team/matchup fundamentals via Supabase read-only RPC |',
    '| `get_injury_and_roster_delta` | `src/swarm/tools/dueloddsRpcTools.ts` | Injury & roster availability deltas via Supabase RPC |',
    '| `get_player_prop_splits` | `src/swarm/tools/dueloddsRpcTools.ts` | Player prop splits by `player_id` & `stat_category` |',
    '| `get_environment_and_weather` | `src/swarm/tools/dueloddsRpcTools.ts` | Venue/weather data (short-circuits for indoor/dome leagues) |',
    '| `get_market_movement` | `src/swarm/tools/dueloddsRpcTools.ts` | Odds/line movement & steam signals |',
    '| `get_historical_lessons` | `src/swarm/tools/dueloddsRpcTools.ts` | Scoped historical lessons from Qdrant Cortex |',
    '| `get_game_context` | `src/swarm/tools/gameContextTool.ts` | Deterministic game context store lookup |',
    '| `duelodds_supabase_lookup` | `src/swarm/tools/supabaseTools.ts` | Publishable/anon-key read-only Supabase lookup |',
    '| `calculator`, `stats_summary`, `probability`, `kelly_edge_sizer`, `monte_carlo_bootstrap` | `src/swarm/tools/mathTools.ts`, `statsTools.ts`, `forecastingTools.ts` | Deterministic local math, statistics, and Kelly/Monte Carlo sizing |',
    '',
    '### Free-Tier Provider/Model Routing & Circuit-Breaker Fallbacks (`src/swarm/providers/`)',
    '',
    `- **Registered Adapters (${adapters.length})**: ${adapters.map((a) => `\`${a}\``).join(', ')}.`,
    `- **Provider Rate & Input Floors (\`PROVIDER_LIMITS\`)**:`,
    '  - `groq`: concurrency `1`, `7,000` TPM floor (`llama-3.3-70b-versatile`: `12,000` TPM; `openai/gpt-oss-120b`/`20b`: `8,000` TPM), `maxInputTokens: 1500`.',
    '  - `mistral`: concurrency `1`, `minSpacingMs: 30000` (2 RPM free tier), `maxInputTokens: 2000`.',
    '  - `gemini`: concurrency `2`, `maxInputTokens: 8000` (retries transient 503 with `1200–2000ms` jitter).',
    '  - `openrouter`: concurrency `1`, `maxInputTokens: 6000`.',
    '  - `nvidia`: concurrency `2`, `maxInputTokens: 8000`.',
    '  - `cloudflare`: concurrency `2`, `maxInputTokens: 6000`.',
    `- **Circuit Breaker & Cooldowns**: \`BREAKER_FAILURE_THRESHOLD\` = \`${breakerThreshold}\`, \`BREAKER_OPEN_MS\` = \`${breakerOpenMs}\` (5 min), \`MODEL_COOLDOWN_MS\` = \`${modelCooldownMs}\` (60s), \`MODEL_TIMEOUT_COOLDOWN_MS\` = \`${timeoutCooldownMs}\` (10 min), \`BILLING_COOLDOWN_MS\` = \`${billingCooldownMs}\` (30 min), \`PROVIDER_CALL_TIMEOUT_MS\` = \`${providerTimeoutMs}\` (25s).`,
    '- **Model Policy**: User-configured models in settings are preserved without silent substitution or blacklisting (`MEMORY.md` / `.omg/rules/model-configuration-policy.md`).',
    '',
    '### Qdrant Collection Config (`src/swarm/memory/`)',
    '',
    `- **Default Collection**: \`${defaultCollection}\` (legacy collections ${legacyCollections.map((c) => `\`${c}\``).join(', ')} auto-remap to default via \`resolveCortexCollectionName\`).`,
    '- **Vector Spec**: Dense `768`-dim (`gemini-embedding-2` / `deterministic-local-768` fallback), distance `Cosine`, `on_disk: true`; sparse vector index `on_disk: true`; `on_disk_payload: true`.',
    `- **Required Payload Indexes (${qdrantIndexes.length})**: ${qdrantIndexes.map((i) => `\`${i.field}\` (${i.schema})`).join(', ')}.`,
    '',
  ];

  return lines.join('\n');
}

function main() {
  const markdown = buildArchitectureMap();
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, markdown, 'utf8');
  const lineCount = markdown.split('\n').length;
  console.log(`[generate-architecture-map] Wrote ${toPosix(path.relative(ROOT, OUT_FILE))} (${lineCount} lines)`);
}

main();
