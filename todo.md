src/swarm/providers/groq.ts

- [x] Stop sending max_tokens: 8192.
- [x] Default to 1024 for analyst and critic calls, 2048 for the manager. A judge JSON fits in that.
- [x] If the caller passes a higher maxTokens, clamp it so estimatedPromptTokens + maxTokens stays under 6000. Never let one call reserve the whole 8,000 TPM budget.

src/swarm/morning/index.ts and the DuelOdds agent list

- [x] Keep one Groq seat only. Market Proposer stays on openai/gpt-oss-120b.
- [x] GodView Compiler stays on mistral-small-latest.
- [x] Do not put a second agent on gpt-oss-120b or gpt-oss-20b. They share the same 8,000 TPM bucket.

Payload size, DuelOdds swarmPromptBuilder.ts

- [x] Cap the string that goes to Groq at 6,000 characters, not 12,000. Task plus data plus baselines.
- [x] Morning baselines stay. Cut alternate markets and old news first.
- [x] Do not send the full pick contract to every agent. The manager gets the JSON contract. The proposers get the board and the baseline.

After this, one lab run should be one Groq call under 6,000 reserved tokens and one Mistral call. The 8,801 error goes away because nothing reserves 8,192. The 413 goes away because the Groq body is smaller.
