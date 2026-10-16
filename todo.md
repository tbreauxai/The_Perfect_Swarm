The Perfect Swarm
Goal: the Render app owns the morning slate. One call judges the day, writes the rows, writes the first-seen lines, and learns from finished games. No Cloudflare Worker loop.
Add POST /api/swarm/morning. Auth is the existing app token. Body is optional { date?: "YYYY-MM-DD" }. Default date is today in America/Chicago.
The route:

- [x] 1. Load the ESPN slate for that date. Same leagues the worker uses: NFL, NBA, MLB, NHL, WNBA, NCAAF, NCAAB. Normalize to event_id like nhl-401892506.
- [x] 2. Read game_judgments for that date from Supabase. Skip any row whose judge_source is swarm. Replace direct and null rows.
- [x] 3. For each remaining game, run the existing swarm analyze path. Use the same judge prompt DuelOdds uses in buildJudgePrompt. Pass raw game data only. Do not pass a prior verdict.
- [x] 4. Write game_judgments with judge_source: "swarm", the real workflow_id from the analyze envelope, win_prob_home, likely_winner, fair spread, fair total, and the model snapshot. Match the columns the dashboard already reads.
- [x] 5. Write one line_snapshots row per game that has scoreboard odds. Fields: event_id, game_date, sport, book, market: "all", spread, total, ml_home, ml_away, snapshot_at, is_baseline: true. Do not send game_id. Skip if an identical line already exists.
- [x] 6. When a judged game is final, record the result through the existing feedback path. Send workflow_id, predictedProbability from win_prob_home, outcome win or loss, sportKey, appId: "duelodds". That is what moves calibration after 8 samples.
- [x] 7. Return { ok, gameDate, judged, replaced, skipped, snapshots, errors }.
- [x] Needs on Render: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY. Qdrant is already set.
- [x] Add a Render cron that calls POST /api/swarm/morning on the morning schedule. Render has no 50-call cap, so one run can finish the slate.
- [x] Do not add a direct-judge fallback. If a game fails, leave it and retry it on the next run.
