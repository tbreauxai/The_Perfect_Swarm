---
description: Permanent rule prohibiting model ban lists and prohibiting overriding user-configured models
globs: "**/*.ts,**/*.tsx,**/*.js,**/*.json"
alwaysApply: true
---

# Model Configuration & Preservation Policy

## Directive 1: Zero Model Ban Lists
- Under NO circumstance should any model blacklist, ban list, or invalid model filter be added to `isValidModel`, `ModelRouter`, or any other module.
- Never attempt to predict, hallucinate, or hardcode which models are active, retired, or deprecated. Gemini 2.5 is no longer in use; never make assumptions regarding model lifecycles.
- `isValidModel` MUST ONLY check that the model string is non-empty (`typeof model === 'string' && model.trim().length > 0`).

## Directive 2: Strict User Configuration Preservation
- Never overwrite, replace, or default user-configured models to arbitrary "recommended" models.
- If the user specifies a model in the settings box (e.g., in `AppSettings`, `SwarmEngineSettings`, or agent config), the swarm MUST execute with that exact model string.
- Respect all user input directly without automated alteration.
