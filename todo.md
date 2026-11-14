The*Perfect_Swarm | ONE PR | fix/tool-rpc-params | base 2c0729e67d27fc07d4960b5244dcd838e7516a1d ("groq fix" = origin/main HEAD and the live Render deploy, rechecked Nov 14 10:3x AM CT) | SWARM ONLY, one pass
GIT: git fetch origin && [ -z "$(git status --porcelain --untracked-files=no)" ] (else STOP; the untracked audit_runbook_perfect_swarm.md is fine, leave it untracked, never add it) && git checkout main && git pull --ff-only (REQUIRED: local main is at 935bfaf, Sep 30, ~420 commits behind; it is an ancestor so ff-only works) && git merge-base --is-ancestor 2c0729e67d27fc07d4960b5244dcd838e7516a1d HEAD (else STOP) && [ -z "$(git branch --list fix/tool-rpc-params)" ] (else STOP) && git checkout -b fix/tool-rpc-params
RULES: commit after each step with explicit `git add <files>` (never -A). Never reset, checkout ., restore, clean, rebase, squash or force-push. Node 22 strip-only TS (no parameter properties, enums, namespaces, import=require or decorators). No secrets; mocked fetch only (0 Supabase/LLM calls). Missing != zero; no fabrication.
WHY: Code Auditor 1:42 PM CST (audit_runbook_duelodds.md L5086). PostgREST matches RPC args by name and every SQL arg is p*-prefixed, so the unprefixed bodies get PGRST202 for all 5 tools.
Bodies on main @2c0729e6 in src/swarm/tools/dueloddsRpcTools.ts (722 lines): L144, L216, L328-333, L420, L511 (rechecked Nov 14; the runbook's L146/218/331/422/513 are 0-2 lines off).
MAPPING (exact; DuelOdds PR #224 merged Nov 14 and LIVE in prod, read-only pg_proc check Nov 14 10:3x AM CT: all 5 exist, STABLE, EXECUTE granted to anon only):
get_matchup_fundamentals_v1(p_game_id TEXT, p_window TEXT='L10')
get_injury_and_roster_delta_v1(p_game_id TEXT, p_position_group TEXT=NULL)
get_player_prop_splits_v1(p_player_id TEXT, p_stat_category TEXT, p_last_n INT=10, p_line NUMERIC=NULL)
get_environment_and_weather_v1(p_game_id TEXT)
get_market_movement_v1(p_game_id TEXT, p_market_type TEXT='all'; accepts spread|total|ml|h2h|all)
STEPS (file | function | action | done-when):

1. [x] src/swarm/tools/dueloddsRpcTools.ts | the 5 callSupabaseRpc calls | send exactly the mapping keys: game_id->p_game_id, window->p_window, position_group->p_position_group, player_id->p_player_id, stat_category->p_stat_category, last_n->p_last_n (integer: Math.trunc), line->p_line, market_type->p_market_type
   Omit optional keys when unset, as today. Keep the tool-facing arg names (game_id etc.) unchanged for the LLM.
   Also resolveSupabaseRpcConfig L18-37: drop the SUPABASE_SERVICE_ROLE_KEY / SUPABASE_SERVICE_KEY fallbacks (L27-28) and reject a key equal to the service key or containing 'service_role' (same rule as getSupabaseReadOnlyConfig, src/swarm/morning/gameContext.ts L251-281). This is publishable key only, so the RPCs run as anon, the only role granted EXECUTE after the DuelOdds PR
   | done-when: `rg -n "\{ game_id:|player_id: playerId|market_type: marketType" src/swarm/tools/dueloddsRpcTools.ts` matches only result objects, not RPC bodies. Commit "fix(tools): send p*-prefixed RPC args, publishable key only".
2. [x] same file | getPlayerPropSplitsTool L346-372 | read the SQL keys: sample_size, mean, median, iqr, hit_rate_pct (already a %), home_hit_rate_pct, away_hit_rate_pct, recent_logs[] of {date,val,min,home}
   Remove the `?? args.last_n` sample fallback (L349), the d.hit_rate\*100 and d.over_count/variance reads, and the join of objects (L353-357).
   player_game_logs has 0 rows in prod, so sample_size 0 / null stats is the live path. Return success true, data d, empty:true, summary "[PLAYER PROP SPLITS: <id> | <stat>] No game logs available (sample 0); no splits." No 0% hit rate, no invented sample
   | done-when: the 0-row mock yields that summary. Commit "fix(tools): prop splits empty-valid on 0 logs, no fabricated sample".
3. [x] same file | getMarketMovementTool L524-551 | read {opening, latest, line_delta, deltas, snapshots_tracked} from the new SQL shape (opening.spread/total/ml_home)
   Remove the invented '-110' prices (L526/L528), the '0' delta fallback (L529-533) and the steam 0 (L535); missing -> 'N/A'. Map tool arg 'ml'/'moneyline' through unchanged (SQL normalizes). snapshots_tracked 0 -> empty:true, "no FanDuel snapshots"
   | done-when: no '-110' literal left in the file. Commit "fix(tools): market movement reads real FanDuel fields, no default prices".
4. [x] TESTS | fixtures/duelodds_tool_rpc_signatures_v1.json (new) + tests/contract/toolRpcParams.test.ts (new) + update src/swarm/tools/dueloddsRpcTools.test.ts
   Fixture: {source:"tbreauxai/DuelOdds supabase/migrations/<phase2_readonly_tool_rpcs>.sql + <phase2_tool_canonical_aliases>.sql (20261109000000/20261113130000 today; 20261114154045/20261114154050 after the reconcile PR)", source_commit:"6f71c6ac78c18f459c473dc3a485d5a594ffcf15 (DuelOdds main, Nov 14)", functions:{name:{args:[{name,type,required}]}}}
   Copy it from the 5 CREATE FUNCTION headers = the MAPPING above (the Swarm repo can't see DuelOdds), and add a header note: "regenerate if the DuelOdds signatures change".
   Contract test: for each of the 5 tools, call execute with all args through a mocked fetchFn and capture URL + JSON body. Assert the RPC name is in the fixture, Object.keys(body) is a subset of the fixture arg names, every required arg is present, and every key starts with p*.
   Also a minimal-args call (no window/last_n/line/position_group) sends only required keys.
   Update the existing tests L80-81, L122-123, L169-172 to the p* keys; replace the L175-177 hit_rate/sample_size mock and the L285-305 '-110' expectations with the real SQL shapes; add 0-log props and 0-snapshot market cases
   A service-role-only env -> supabase_not_configured. Commit "test(tools): RPC arg contract vs DuelOdds migration signatures".
   SMOKE: npm run build && node scripts/smoke-start.mjs (Dockerfile CMD `node --experimental-strip-types server.ts`) -> "[smoke] GET /api/health -> 200" + "[smoke] PASS".
   VERIFY ONCE: env -u SWARM_APP_TOKEN npx vitest run (paste the real totals, never invent them); npm run lint (= tsc --noEmit); npx tsc --noEmit --erasableSyntaxOnly --verbatimModuleSyntax -p . (TS1484 lines already on main are not new); npm run build; npx oxlint if present (otherwise "not present"); the smoke test
   secret scan: git diff main | rg -n "sk-or-v1-[A-Za-z0-9]{20,}|service_role|eyJ[A-Za-z0-9*-]{20,}|gsk*[A-Za-z0-9]{20,}" returns nothing outside the literal 'service_role' guard string and its test.
   Paste git log --oneline main..HEAD and git diff --stat main; confirm the diff is non-empty. Then: git push -u origin fix/tool-rpc-params && gh pr create --base main --title "fix(tools): p*-prefixed DuelOdds RPC args + contract test, no fabricated props/movement". No auto-merge.
   NEVER push to main; push only the feature branch.
   TYLER: ORDER IS SATISFIED: both RPC migrations are applied in prod (recorded as 20261114154045 + 20261114154050; the 5 \_v1 functions take p_game_id/p_window, p_position_group, p_player_id/p_stat_category/p_last_n/p_line, p_market_type). Merge any time except 9-10 PM CT; it does not wait on the reconcile PR.
   Render srv-dan9l6ek1f9s73fvd6a0 auto-deploys on merge, so merge = deploy; approve in Code Auditor's chat. Don't merge between 9 and 10 PM CT. Afterwards GET https://the-perfect-swarm.onrender.com/api/health -> 200, then run one chat parlay and look for no PGRST202 in Render logs.
   Rollback: the Render deploy for 2c0729e6 (live since Nov 13 ~1:04 PM CT; record its dep- id before merging). No DB, KV, env or flag changes.
