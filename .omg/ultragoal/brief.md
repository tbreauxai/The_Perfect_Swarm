# Ultragoal Brief: Resilient Generative UI Trend Normalization & Schema Validation Safeguard

## Objective
Eliminate runtime `SCHEMA_VALIDATION_FAILED` errors caused by non-strict LLM trend strings in Generative UI `MetricCard` components (e.g. `components.3.props.trend: Invalid option: expected one of "up"|"down"|"neutral"`).

## Problem Analysis
When Manager/Orchestrator LLMs synthesize dashboard cards, models frequently emit natural language variations or synonyms for trend:
- `"increasing"`, `"upward"`, `"positive"`, `"rising"`, `"UP"`, `"+"`
- `"decreasing"`, `"downward"`, `"negative"`, `"falling"`, `"DOWN"`, `"-"`
- `"flat"`, `"stable"`, `"none"`, `"no change"`, `"even"`, `"neutral"`
- Or unexpected text/numbers/null.

Under the previous strict `z.enum(["up", "down", "neutral"])` definition:
1. `config.zodSchema.safeParse(parsedOutput)` in `src/swarm/agent.ts` throws a fatal `SCHEMA_VALIDATION_FAILED` error.
2. The entire analysis fails, even though the dashboard title, other cards, insight lists, and data tables are completely valid.

## Architecture Boundaries & Solution
1. **Schema-Level Normalization (`src/swarm/schemas.ts`)**:
   - In `ManagerResponseSchema` -> `MetricCard` -> `props.trend`:
     Use `z.preprocess` to normalize casing, map common synonyms (`increasing`/`upward` -> `'up'`, `decreasing`/`downward` -> `'down'`, `flat`/`stable` -> `'neutral'`), and map unrecognized strings or invalid values to `undefined` rather than throwing fatal validation errors.
   - In `InsightList` -> `props.insights` -> `type`:
     Preprocess to map synonyms (`alert`, `danger` -> `warning`, `notice` -> `info`) to prevent similar enum failures.
2. **Parser Guarding (`src/swarm/parser.ts`)**:
   - Standardize `normalizeTrend` helper across both `parser.ts` and `schemas.ts`.
3. **Agent Self-Healing (`src/swarm/agent.ts`)**:
   - In `agent.run()`, if `config.zodSchema` validation fails and the output has generative UI structure (`components`), invoke `guardManagerResponse` to salvage the payload before throwing `SCHEMA_VALIDATION_FAILED`.
4. **Verification**:
   - Unit tests covering case-insensitivity, synonyms, arbitrary string fallback, null/undefined safety, and agent recovery without error.
