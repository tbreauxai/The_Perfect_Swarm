Swarm Fix: Risk Critic Must Emit Top-Level "pass" Field

Current Failure

Risk Critic — Verification FAILED on attempt 1. Feedback: Critic output missing pass field.
Risk Critic — Verification FAILED on attempt 2. Feedback: Critic output missing pass field.
system — Exhausted 2 retries. Proposer failed to pass verification (RLAIF Rating: 35%).

Current Risk Critic model: groq / openai/gpt-oss-120b

Problem

The verifier requires a top-level boolean "pass" field on the Risk Critic (and GodView Compiler) output. The Critic is still not emitting it.

The prompt already instructs:



The Risk Critic and GodView Compiler MUST also include top-level boolean "pass"

Despite this, the actual JSON returned by the Critic lacks the field.

Required Fix

1. Force the field in the Critic output contract

The Risk Critic must always return a single top-level JSON object that includes:

{
  "analysis": "...",
  "picks": [],
  "scorecards": [],
  "pass": true
}

or

{
  "analysis": "...",
  "picks": [],
  "scorecards": [],
  "pass": false
}





"pass" is a boolean at the top level.



true = no fatal issues found.



false = proposed picks fail review.



The critic’s scorecard should mirror the same verdict.

2. Strengthen the prompt (near the output rules)

Add an explicit example the model cannot miss:

Risk Critic REQUIRED shape:
{
  "analysis": "No fatal issues.",
  "picks": [],
  "scorecards": [{"verdict": "pass"}],
  "pass": true
}
Missing the top-level "pass" boolean is an automatic failure.

3. Optional hardening





Post-process the Critic response and inject "pass": false (or true) if the field is absent, so verification does not hard-fail on schema shape.



Or switch the Risk Critic to a model that more reliably follows strict JSON schemas if openai/gpt-oss-120b continues to omit the field.

4. GodView Compiler

Must preserve and also emit the top-level "pass" field when required by the verifier.

Acceptance Criteria





Risk Critic responses include a top-level boolean "pass".



Verification no longer fails with “Critic output missing pass field.”



At least one full Swarm run completes without exhausting retries on this schema error.

Test

Run a simple recommendation request. Confirm the Critic JSON contains "pass": true or "pass": false and that verification proceeds.