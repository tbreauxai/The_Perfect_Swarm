# Ultragoal Brief: Fix 5 - Continuous Learning Loop

## Objective
Implement Fix 5 (the learning loop) in `tbreauxai/The_Perfect_Swarm` and `tbreauxai/DuelOdds`.
A graded win, loss, or push updates the stored judgment that produced it in the shared cortex, and subsequent retrievals use that score. Grades persist across process restarts.

## Constraints & Boundaries
- Single shared Qdrant collection (`pwa_swarm_dev_cortex_v2`): do NOT split the cortex.
- Do NOT change caller auth, CORS, or provider-key handling.
- Do NOT commit secrets (.env, API keys, tokens).
- Maintain 100% test passing across all existing suites.
- Open a PR in each repository targeting `main`.

## Swarm Architecture
1. **Payload & Indexing**: Store `workflowId` on memory payloads in Qdrant and in-memory fallback store. Register a keyword payload index for `workflowId`.
2. **Persistent Feedback Grading**:
   - `/api/swarm/feedback` resolves point by `workflowId` and `originApp` (derived from authenticated caller token, ignoring client body `appId`).
   - If in-memory record in `knowledgeRepository` is missing (after restart), grade point directly in Cortex.
   - Outcome ratings: win = 1.0, push = 0.5, loss = 0.0.
   - Point payload update: `qualityRating` set to outcome score, `memoryType = 'fact'`, `outcome`, `gradedAt`, `feedbackProcessed: true`.
   - Idempotent: second grade for same `workflowId` returns success without modifying score.
   - Return 404 only when no point has that `workflowId` for that `originApp`.
3. **Retrieval Scoring**:
   - Retrieval uses the graded score (`qualityRating`).
   - For same domain and entity: win (1.0) ranks above push (0.5), which ranks above loss (0.0).
   - Ungraded placeholder (0.85/0.90) must not outrank a graded loss (empirical facts/graded outcomes take precedence, or graded points reflect empirical feedback).
   - Same-app weight (1.0) outranks sibling weight (0.45).
4. **Diagnostics**:
   - Separate graded points from ungraded judgments.
   - Headline accuracy = (graded wins) / (graded outcomes), or `null` when none graded.
   - Do not display 0.85 placeholder as if it were a performance result.

## DuelOdds Architecture
1. **WorkflowId Persistence**:
   - Persist returned `workflowId` on every AI recommendation produced by the swarm.
   - If response has no `workflowId`, log and do not invent one.
2. **Settled Bet Feedback Posting**:
   - Every settled AI bet with a `workflowId` posts `win`, `loss`, or `push` to `https://the-perfect-swarm.onrender.com/api/swarm/feedback` with caller token.
   - Include `workflowId`, `outcome`, `gradedAt`.
   - Treat 200 and already-processed response as success; log 404s.
   - Do NOT post bets that never came from the swarm.
