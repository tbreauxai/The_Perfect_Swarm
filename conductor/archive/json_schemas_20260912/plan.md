# Implementation Plan: Structured JSON Schemas

## Phase 1: Define Zod Schemas [checkpoint: 9b95e1c]
- [x] Task: Define schemas in shared types 9b95e1c
  - [x] Write Tests: Create unit tests for Zod schema validation (e.g. testing valid/invalid Analyst outputs).
  - [x] Implementation: Create a new file (e.g., `src/schemas.ts` or add to `server.ts`) defining the Zod schemas for Analyst and Manager nodes.
- [x] Task: Phase Verification & Checkpoint (Refer to workflow.md)

## Phase 2: Update Agent Prompts [checkpoint: 4861079]
- [x] Task: Integrate JSON schema instructions into system prompts 4861079
  - [x] Write Tests: Ensure prompt generation functions (if applicable) include the stringified schema or strict JSON requirements.
  - [x] Implementation: Update the `System Orchestrator`, `Analyst`, and `Manager` prompts in `swarm.ts` to strictly require JSON format matching the defined Zod schemas.
- [x] Task: Phase Verification & Checkpoint (Refer to workflow.md)

## Phase 3: Implement Runtime Validation [checkpoint: 36d99d7]
- [x] Task: Validate and handle LLM responses 36d99d7
- [x] Task: Phase Verification & Checkpoint (Refer to workflow.md)
