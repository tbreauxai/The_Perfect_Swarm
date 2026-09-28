# Ultragoal Brief: Perfect Swarm Audit Fixes Implementation

## Objective
Implement all audit fixes documented in `todo.md` sequentially across client and backend modules:
1. Fix 1: Prune dead model IDs from the grader/prompt-generator lists into a unified `WORKING_MODELS` list, and repoint deprecated agent defaults.
2. Fix 2: Prevent grader failure from marking the tested model as "Error"; record on `gradingError` and update status badges to amber "Grade failed".
3. Fix 3, 7, 8: Sort managers in full swarm combinations by combined score; properly catch and re-throw error objects in grader; split shared failover rotation cursor into separate prompt-generator and grader cursors.
4. Fix 4, 5: Add ISO timestamps to history entries, increase history cap to 100, add Tested column to history table, defer clearing test results until first result lands, and add "Use this" button to apply best model configuration into Settings.
5. Fix 6: Update health checker so that models without API keys return `circuitState: 'UNCHECKED'`, `healthy: false`, `latencyMs: null`, and render an amber "unchecked" badge with "—" latency instead of false "✓ healthy, 0ms".
6. Fix 9, 10: Harden grader prompt against self-scoring with `<analyst_output>` boundaries and directives; add client-side grader cache to avoid burning LLM quota.
7. Backend Fixes 1, 2, 3: Make `POST /api/swarm/analyze` resilient against post-execution drops; strip absolute stack traces from SSE `swarm_error` events; count non-2xx HTTP responses as telemetry failures.
8. Full Verification: Run full test suite, lint checks, and build verification.

## Constraints & System Boundaries
- Preserve existing component contracts and backwards compatibility.
- Ensure deterministic speed score calculations.
- Maintain test coverage and pass all CLI, server, portable, and simulation tests.
- Fail-closed execution: each micro-goal must be independently verified before advancing.
