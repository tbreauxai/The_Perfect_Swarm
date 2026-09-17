# Agent Memory & Permanent Architectural Rules

## Critical Rule: User Model Selection & Zero-Ban Policy (STRICT & MANDATORY)

1. **NEVER Ban or Blacklist Any Models**:
   - Do NOT maintain, add, or suggest any model blacklist, ban list, or rejection list (e.g. in `isValidModel` or anywhere in the codebase).
   - Do NOT assume or hallucinate model lifecycle status (e.g. Gemini 2.5 is no longer in use; never assume what is or isn't active).
   - Any non-empty model string supplied by the user must always be treated as 100% valid (`isValidModel` must only check that the string is non-empty).

2. **NEVER Override or Default User-Configured Models**:
   - NEVER override the model names configured by the user in settings, UI, or config files.
   - Always execute models EXACTLY as specified by the user in the settings box (`managerConfig.model`, `agent.model`, etc.).
   - Do NOT substitute with "recommended" or "default" models when a user has provided a model in the settings box.
   - If an API returns an error for a user's model, surface the exact error directly. Do NOT silently overwrite or substitute the user's configured model.

3. **Zero-Crash Worker Guarding**:
   - Worker analyst responses must be processed via `guardAnalystResponse` to safely handle prose, markdown, or JSON without throwing fatal `SCHEMA_VALIDATION_FAILED` errors.
