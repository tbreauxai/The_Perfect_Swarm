# Objective
Implement dynamic model selection dropdowns in the UI that pull available (and free) models directly from the active provider APIs (OpenRouter, Groq, Mistral, GitHub Models, Gemini) instead of relying on a free-text input or hardcoded lists.

## Context and Constraints
- **OpenRouter**: Has a public unauthenticated `/api/v1/models` endpoint. We can filter for `pricing.prompt === "0"` and `pricing.completion === "0"`.
- **Groq**: Uses `/openai/v1/models` (requires auth). All beta models are technically free.
- **Mistral / GitHub**: Provide standard `/v1/models` (or equivalent) requiring auth.
- **Gemini**: Provides `models.list` requiring auth.
- The UI (specifically `SettingsModal.tsx`) needs to display a dropdown instead of a text input for the `model` property.
- API keys stored in state/localStorage should be used to fetch these lists dynamically upon provider selection or modal open.
- Handle loading and error states cleanly so the user isn't blocked if a fetch fails.
