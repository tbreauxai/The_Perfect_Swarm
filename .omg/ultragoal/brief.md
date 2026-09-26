# Ultragoal Brief: Optimizer Grading System & Response Validity Architecture

## Objective
Debug and repair the Model Optimizer evaluation pipeline within `src/components/optimization/OptimizationRunner.tsx` and the underlying Swarm execution engine:
1. Fix the grading system (`autoGradeOutput` and `generateTestPrompt`) which currently fails silently and outputs no scores (`-`).
2. Correct the "Valid" model designation so that models are only marked "Valid" if they return a substantive, complete, and uncorrupted response (rather than merely not returning an explicit HTTP error code).
3. Ensure full swarm combination benchmarking unblocks and operates reliably once valid models are evaluated and scored.

## Constraints & System Boundaries
- Must support any LLM provider configured by the user (OpenRouter, Groq, Gemini, Mistral, GitHub, Simulated) without hardcoded provider dependencies or invalid model identifiers.
- Deterministic metrics (such as speed score based on elapsed duration) must never depend on flaky LLM generation.
- Response validity checks must verify actual response payload integrity: non-null, non-empty, valid components or insight data, and absence of execution error wrappers (`ui_title: 'Execution Error'`, etc.).
- Maintain backwards compatibility with the existing UI and history storage (`swarm_optimization_history`, `swarm_model_errors`).

## Architecture Root Causes
1. **Hardcoded Grader Agent Configuration**: Both `generateTestPrompt` and `autoGradeOutput` hardcode `provider: 'gemini'` and `model: 'gemini-flash-lite-latest'`, ignoring `managerAgent` and failing when Gemini is unconfigured or when the non-existent model name causes 404/unsupported model errors.
2. **Schema & Orchestration Mismatch**: `/api/swarm/analyze` executes the full multi-agent synthesis pipeline returning `ManagerResponseSchema` (Generative UI with `ui_title` and `components`), whereas `autoGradeOutput` expects raw JSON `{ intelligence, accuracy, speed }`.
3. **Naive Validity Check**: The status column (`{r.error ? 'Error' : 'Valid'}`) only checks `r.error`, causing failed executions, empty outputs, and embedded errors (`ui_title: 'Execution Error'`) to be falsely badged as "Valid".
4. **Combination Runner Deadlock**: `runFullSwarmCombinations` filters models with `(r.scores.accuracy || 0) >= 5`. Because auto-grading fails, `accuracy` is always `null` (0), permanently blocking combination testing.
