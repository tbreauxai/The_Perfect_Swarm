# Specification: Structured JSON Schemas for Swarm Nodes

## Overview
The swarm currently relies on loosely structured, free-form conversational text for inter-node communication. To improve reliability, reduce token overhead, and minimize latency, this track will implement strict, structured JSON schemas for communication between the Manager Node and the Analyst Agents.

## Functional Requirements
- **Zod Schema Definition**: Define strict Zod schemas for the expected output of Analyst Agents (e.g., insights, anomalies, summary).
- **Prompt Engineering**: Update the system prompts of all agents to explicitly require JSON output adhering to the defined Zod schemas.
- **Runtime Validation**: Implement runtime validation using Zod's `.parse()` or `.safeParse()` when receiving responses from the LLM providers.
- **Error Handling**: If an LLM returns invalid JSON or fails the schema validation, the system should catch the error gracefully and surface it in the execution trace rather than crashing the backend.

## Non-Functional Requirements
- **Performance**: The Zod validation should add negligible latency to the overall processing time.
- **Maintainability**: Schemas should be defined centrally (e.g., in `server.ts` or a shared `types.ts`) so they can be easily reused and updated.

## Acceptance Criteria
- All Analyst Agents return strictly formatted JSON objects matching the schema.
- The backend successfully parses and validates the responses.
- The UI trace correctly displays the structured data without breaking.
- If an LLM hallucinates non-JSON text, the backend logs a validation error and continues execution gracefully.

## Out of Scope
- Semantic caching with Qdrant (deferred to a future track).
- Adaptive load balancing and dynamic agent routing (deferred to a future track).
