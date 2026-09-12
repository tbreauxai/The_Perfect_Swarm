# Implementation Plan: Structured JSON Schemas

## Phase 1: Define Zod Schemas [checkpoint: 9b95e1c]
- [x] Task: Define schemas in shared types 9b95e1c
  - [x] Write Tests: Create unit tests for Zod schema validation (e.g. testing valid/invalid Analyst outputs).
  - [x] Implementation: Create a new file (e.g., `src/schemas.ts` or add to `server.ts`) defining the Zod schemas for Analyst and Manager nodes.
- [x] Task: Phase Verification & Checkpoint (Refer to workflow.md)

## Phase 2: Update Agent Prompts
- [ ] Task: Integrate JSON schema instructions into system prompts
  - [ ] Write Tests: Ensure prompt generation functions (if applicable) include the stringified schema or strict JSON requirements.
  - [ ] Implementation: Update the `System Orchestrator`, `Analyst`, and `Manager` prompts in `swarm.ts` to strictly require JSON format matching the defined Zod schemas.
- [ ] Task: Phase Verification & Checkpoint (Refer to workflow.md)

## Phase 3: Implement Runtime Validation
- [ ] Task: Validate and handle LLM responses
  - [ ] Write Tests: Mock LLM responses (valid, invalid JSON, hallucinated text) and test that the execution trace handles errors gracefully without crashing.
  - [ ] Implementation: Use Zod `.safeParse()` on the parsed JSON output from providers in `swarm.ts`.
  - [ ] Implementation: If parsing fails, construct an error object and append it to the trace instead of throwing a fatal error.
- [ ] Task: Phase Verification & Checkpoint (Refer to workflow.md)
