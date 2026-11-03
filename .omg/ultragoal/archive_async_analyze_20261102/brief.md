# Ultragoal Brief: Opt-in async /analyze and /morning (202 + status poll)

## Objective
Implement opt-in async execution for `/api/swarm/analyze` and `/api/swarm/morning` via `Prefer: respond-async` header returning 202 `{workflowId, status: "pending"}` immediately to avoid Cloudflare 100s timeout (524s), with job status polling at `GET /api/swarm/analyze/status/:workflowId`. Preserves all synchronous behavior by default.

## Constraints & Rules
- Branch: `feat/async-analyze` from `main` (`68ab9d31216f3c61e436843bec0765f7d572d476`)
- Single branch, one commit per step, `git add <files>` only (never `-A`)
- Never run: `git reset`, `git checkout .`, `git restore`, `git clean`, `git rebase`, or squash
- In-memory job store on single Render web instance (TTL 60 min, cap 500 entries)
- Zero DB schema changes, zero migrations, zero secrets/env modifications
- Morning lock held during background async run until settled
- Strip-types Node 22 compatibility (TS1484 count must remain exactly 10)
