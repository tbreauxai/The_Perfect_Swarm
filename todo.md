The morning run is writing a judgment even when the swarm did not return one. parseAndValidateJudgeOutput in src/swarm/morning/judgePrompt.ts fills missing fields with winProbHome: 0.5 and fairSpread: 0, then upsertGameJudgment saves that as success. That is why 19 games were replaced and every card shows 50% and a fair spread of 0.
runMorningSlate takes workflowResult.finalAnalysis, stringifies it, and treats that string as the judge JSON. The manager synthesis does not emit that schema. It emits the normal swarm analysis. The parser cannot find winProbHome, so it invents 0.5.
Fix it in three places.
src/swarm/morning/judgePrompt.ts
- [x] • Stop defaulting. If winProbHome is missing, not a number, or outside 0.01–0.99, return null.
- [x] • If fairSpread is missing or not a number, return null.
- [x] • A 50% / 0 result is only valid if those fields were actually in the JSON. Do not invent them.
- [x] • If finalAnalysis is an object, read winProbHome and fairSpread off it before falling back to a JSON string. Also check result, judgment, and a fenced code block.
src/swarm/morning/index.ts
- [x] • If parseAndValidateJudgeOutput returns null, do not upsert. Push { eventId, error: "judge output missing winProbHome or fairSpread" } and leave the existing row.
- [x] • Pass the judge schema as the required manager output, not only as the task text. The GodView Compiler has to emit the raw JSON object from buildJudgePrompt. If the workflow has a response schema or a manager instruction, set it there.
- [x] • Do not count a defaulted row as replaced or judged.
src/swarm/morning/supabase.ts
- [x] • Refuse to write a row whose win_prob_home is 0.5 and fair_spread is 0 unless the parser marked it as explicitly returned. A missing judgment must not overwrite a real one.
After this is deployed on Render, the next /api/cron/force?job=morning should either write real probabilities or return errors for the games it could not judge. It should not write another slate of 50% and 0.
