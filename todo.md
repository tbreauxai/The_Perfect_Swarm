Fix two deterministic bugs exposed by workflow `wf-1795791265871`:

1. **Scope `symmetric_injury_misread` per-pick instead of whole-analysis (Verifier / Risk Critic grounding check):**
   - Locate where `symmetric_injury_misread` emits `"is covered by seat analysis health-advantage claim"`.
   - When checking a specific pick in a multi-leg parlay, check ONLY that pick's own `reason` / `reasons` fields (or the specific sentence/clause naming that pick's team/rowId)—NOT the entire multi-leg `analysis` paragraph, which legitimately mentions `"asymmetric health advantage"` for a *different* leg (e.g., Florida Panthers ML) while explicitly stating the other legs have symmetric health.
   - Also ignore negated/explicitly symmetric statements (e.g., `"Health balances are symmetric for..."`).

2. **Include `"multi"` in `HybridCortex` `appliedDomains`:**
   - When querying Qdrant (`pwa_swarm_dev_cortex_v4`), append `"multi"` to `appliedDomains` whenever `allowParlay` is true or `domains.length > 1` (or `domain === "multi-sport"`), so multi-sport/parlay lessons are retrieved instead of returning `recordsFound: 0`.

3. **Check `manager` provider routing:**
   - Inspect why `manager` attempted `cloudflare/@cf/meta/llama-3.3-70b-instruct-fp8-fast` first when `settings.agents` specified `groq / openai/gpt-oss-120b`. Report if a hardcoded override or fallback order is ignoring the configured `manager` provider.

Add unit tests for:
- A 3-leg parlay where leg 3 claims `"asymmetric health advantage"` and legs 1–2 claim `"form + steam"` with symmetric health -> must NOT trigger `symmetric_injury_misread` on legs 1–2.
- `appliedDomains` including `"multi"` on multi-sport / parlay queries.

Run typecheck and vitest, then summarize the diff.