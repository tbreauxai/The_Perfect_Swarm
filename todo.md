Swarm Fix: Enable Tool Calling (or Properly Intercept in Two-Hop Planner)

Problem

Agents are attempting to call the new filtered data tools, but the Swarm is sending provider requests with tool calling disabled. This causes immediate failures.

Observed error

Groq API Error (400): 
"Tool choice is none, but model called a tool"
failed_generation: {
  "name": "tool_execution",
  "arguments": {
    "tool": "get_matchup_fundamentals",
    "parameters": {
      "game_id": "nba-401909299",
      "window": "season"
    }
  }
}

The model correctly tried to call get_matchup_fundamentals with a real game ID.
The provider rejected it because the request was sent with tools disabled (tool_choice: none or equivalent).

Root Cause

Mismatch between prompt and runtime:





The prompt tells agents the filtered tools exist and that the two-hop planner will perform tool calls.



Agents are still emitting tool calls (or the planner is not intercepting them).



The Swarm engine is sending the provider request with tool calling turned off.



Result: provider rejects the call.

Required Fix (choose one)

Option A — Enable tool calling on provider requests (simplest)

When agents are allowed to request data tools, send the provider request with tool calling enabled:





Set tool_choice to "auto" (or the provider equivalent) instead of "none".



Include the available tool definitions (get_matchup_fundamentals_v1, get_injury_and_roster_delta_v1, get_environment_and_weather_v1, get_market_movement_v1, get_player_prop_splits_v1, etc.) in the request.



Let the provider return tool calls, then execute them via the two-hop planner / tool layer and continue the conversation.

Option B — Fully intercept in the two-hop planner (preferred if you want to keep provider tool calling off)





Detect when an agent emits a tool request (even if it appears as a pseudo tool_execution block or native tool call).



Intercept it before it reaches the provider.



Execute the tool via the existing two-hop planner.



Inject the tool result back into the agent context.



Never send a request that has tool_choice: none while the model is still trying to call tools.

Additional Notes





The Critic schema issue (missing pass field) is separate and still needs to be fixed, but it is not the cause of this tool error.



The tools themselves appear to be live; the failure is only in how the Swarm invokes them.



After the fix, tools_called on recommendations should start populating, and agents should be able to retrieve matchup fundamentals, injuries, weather, market movement, etc. on demand.

Acceptance Criteria





No more "Tool choice is none, but model called a tool" errors.



Agents can successfully call at least one of the filtered tools (e.g. get_matchup_fundamentals_v1 with a slate event ID).



Tool results appear in the agent context / final analysis.



tools_called is non-empty on Swarm recommendations that used tools.



Verification can proceed past the tool-calling stage (Critic pass field issue is tracked separately).

Test

Run a simple NBA or NHL parlay/recommendation request with only the compact slate in the prompt.
Confirm an agent issues a filtered tool call, receives a result, and the run does not fail with the tool_choice error.