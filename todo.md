Phase 1: Swarm Engine Resilience (The_Perfect_Swarm) [COMPLETED]
Relax & Auto-Repair Scorecards (scorecard.ts): [COMPLETED]
[x] Enhance validateScorecard to auto-extract row IDs via regex (/R\d+/g) from unstructured markdown/prose if standard JSON parse fails.
[x] If an analyst returns valid unstructured recommendations instead of raw JSON, preserve the text as a synthesized scorecard rather than dropping the seat.
Prevent Analyst Dropping on Multi-Chunk (clusterPipeline.ts): [COMPLETED]
[x] Ensure all active analysts evaluate the primary chunk or receive distributed chunk assignments with minimum 1 execution per analyst.
Adaptive Token Capping & Fallback Chain (groq.ts & agentResolution.ts): [COMPLETED]
[x] Ensure computeGroqScorecardMaxTokens prunes input history before rejecting requests under the 7,000 TPM limit.
[x] Never disable provider fallbacks on transient rate limits (429) or limiter skips even if disableFallback is toggled.
