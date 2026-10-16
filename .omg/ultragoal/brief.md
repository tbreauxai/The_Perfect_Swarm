# Ultragoal Brief: Render Morning Slate Engine (POST /api/swarm/morning)

## Objective
Enable The Perfect Swarm backend on Render to own the morning slate end-to-end:
One API call judges the day's games via Swarm intelligence, persists rows to Supabase `game_judgments` and `line_snapshots`, and learns from finished games via the calibration feedback loop without any Cloudflare Worker execution limits.

## Route Specification
- **Path**: `POST /api/swarm/morning`
- **Auth**: Existing app token authentication (`Bearer <token>` checked by `createAppAuthMiddleware`)
- **Body**: Optional `{ date?: "YYYY-MM-DD" }`. Defaults to today in `America/Chicago`.
- **Response**: `{ ok: boolean, gameDate: string, judged: number, replaced: number, skipped: number, snapshots: number, errors: Array<{ eventId: string, error: string }>, settled: number }`

## Pipeline Phases & Status
1. [x] **ESPN Slate Loader**: Fetch scoreboard data from ESPN public API across NFL, NBA, MLB, NHL, WNBA, NCAAF, NCAAB for the target date. Normalize event IDs to `${league}-${id}` (e.g. `nhl-401892506`).
2. [x] **Supabase Judgment Ingestion & Filtering**: Read `game_judgments` for that date using `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. Skip games already judged by `judge_source: "swarm"`. Replace rows where `judge_source` is `"direct"` or `null`.
3. [x] **Swarm Debate & Judgment Execution**: For each unjudged/replaced game, execute the existing swarm analyze path with the judge prompt (`buildJudgePrompt`) passing raw game data only. No direct-judge fallback; failed games leave cleanly for retries.
4. [x] **Game Judgments Persistence**: Upsert `game_judgments` with `judge_source: "swarm"`, real `workflow_id` from the analyze envelope, `win_prob_home`, `likely_winner`, `fair_spread`, `fair_total`, `model_snapshot`, and all matching dashboard columns.
5. [x] **First-Seen Line Snapshots**: Write one `line_snapshots` row per game that has scoreboard odds (`event_id`, `game_date`, `sport`, `book`, `market: "all"`, `spread`, `total`, `ml_home`, `ml_away`, `snapshot_at`, `is_baseline: true`). Do not send `game_id`. Skip identical existing lines.
6. [x] **Finished Game Outcome Feedback**: Identify judged games that are final, compute outcome (`win`/`loss`/`push`), and dispatch feedback with `workflow_id`, `predictedProbability` (`win_prob_home`), and `appId: "duelodds"` to drive calibration.
7. [x] **Render Cron Configuration**: Declared Render cron service in `render.yaml` executing `scripts/morning-cron.mjs` on morning schedule (`0 11 * * *` UTC).
8. [x] **Verification**: Full unit/integration suite (`src/swarm/server/morning.test.ts`), `npm run lint` (`tsc --noEmit`), `npm test` (694 tests passed), and `npm run build` verified clean.
