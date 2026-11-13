Follow-up: Tool Calling Still Disabled on Provider Requests
Status
The previous fix did not resolve the issue. The error is still occurring:

Groq API Error (400): "Tool choice is none, but model called a tool"
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
Newest Swarm recommendation (2026-11-13 09:20 UTC) still has tools_called: [].
Agents are attempting to call the live tools with real game IDs.
The provider is still rejecting them because the request arrives with tools disabled.
Root Cause (unchanged)
The Swarm is still constructing provider requests with tool_choice: "none" (or equivalent) while the model is trying to emit a tool call.

The earlier change either:

Did not update the actual request builder used for Groq / OpenAI-compatible providers, or
Only updated one code path while another still forces tools off.
Required Change
Search the Swarm codebase for every place that sets tool calling behavior, including:

tool_choice
toolChoice
"none"
Groq / OpenAI-compatible request builders
Any adapter that constructs chat completion payloads
Then do one of the following:

Preferred (enable tools)
When agents are allowed to use the filtered data tools:

Set tool_choice to "auto" (or provider equivalent) instead of "none".
Include the tool definitions (get_matchup_fundamentals_v1, get_injury_and_roster_delta_v1, get_environment_and_weather_v1, get_market_movement_v1, get_player_prop_splits_v1, etc.) in the request.
Handle the returned tool call via the two-hop planner and continue.
Alternative (intercept before provider)
Detect the tool request before it is sent.
Execute it through the two-hop planner.
Inject the result.
Do not send any request that has tool_choice: none while the model is still attempting a tool call.
Acceptance
No more "Tool choice is none, but model called a tool" errors.
At least one filtered tool call succeeds and its result appears in context.
tools_called is non-empty on recommendations that used tools.
Test
Run a compact-slate NBA/NHL recommendation request. Confirm an agent can call get_matchup_fundamentals_v1 (or similar) with a slate event ID without the provider rejecting the request.