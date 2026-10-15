# THE PERFECT SWARM — OpenRouter "instant" model swap (meta-llama/llama-3.3-70b-instruct:free removed)

Repo: tbreauxai/The_Perfect_Swarm Base commit: 7d016ba ONE PR. Perfect Swarm only (no DuelOdds).
Why: OpenRouter removed meta-llama/llama-3.3-70b-instruct:free. Live check 2026-10-15 ~9:30 AM CT of https://openrouter.ai/api/v1/models:
meta-llama/llama-3.3-70b-instruct:free -> NOT listed
nvidia/nemotron-3-super-120b-a12b:free -> LISTED (live) <- replacement
(The paid meta-llama/llama-3.3-70b-instruct is still listed, but we stay on :free.)

GIT RULES (Tyler's standing rule — follow exactly)

- Start: git fetch origin && git checkout -b openrouter-instant-swap 7d016ba
- After EACH step passes its Acceptance: git add -A && git commit -m 'step N'
- NEVER run: git reset (soft or hard), git checkout ., git restore, git clean, git rebase, or any squash. Tyler squashes on merge.
- Before submitting, paste the output of BOTH:
  git log --oneline 7d016ba..HEAD
  git diff --stat 7d016ba
  and confirm the PR's "Files changed" tab is NOT empty and matches the list at the bottom.

RULES FOR EDITS

- Each step gives path:line at 7d016ba, a BEFORE block copied from the file by script, and an AFTER block. Replace BEFORE with AFTER.
- If a BEFORE block does not match character-for-character, STOP and report it. Do not improvise.

---

[x] STEP 1 — src/swarm/router.ts:150-154 OpenRouter instant model
BEFORE:

```
                return complexity === 'complex'
                    ? 'nvidia/nemotron-3-super-120b-a12b:free'
                    : complexity === 'instant'
                    ? 'meta-llama/llama-3.3-70b-instruct:free'
                    : 'nvidia/nemotron-3-super-120b-a12b:free';
```

AFTER:

```
                return complexity === 'complex'
                    ? 'nvidia/nemotron-3-super-120b-a12b:free'
                    : complexity === 'instant'
                    ? 'nvidia/nemotron-3-super-120b-a12b:free'
                    : 'nvidia/nemotron-3-super-120b-a12b:free';
```

(Kept as a ternary so a different instant id can be dropped in later without restructuring.)
Acceptance: Steps 2-3 pass.

[x] STEP 2 — src/swarm/router.test.ts:131
BEFORE:

```
            expect(ModelRouter.getRecommendedModel('openrouter', 'instant')).toBe('meta-llama/llama-3.3-70b-instruct:free');
```

AFTER:

```
            expect(ModelRouter.getRecommendedModel('openrouter', 'instant')).toBe('nvidia/nemotron-3-super-120b-a12b:free');
```

Acceptance: `npx vitest run src/swarm/router.test.ts` passes.

[x] STEP 3 — src/swarm/router-lifecycle.test.ts:44
BEFORE:

```
        expect(ModelRouter.getRecommendedModel('openrouter', 'instant')).toBe('meta-llama/llama-3.3-70b-instruct:free');
```

AFTER:

```
        expect(ModelRouter.getRecommendedModel('openrouter', 'instant')).toBe('nvidia/nemotron-3-super-120b-a12b:free');
```

Acceptance: `npx vitest run src/swarm/router-lifecycle.test.ts` passes.

[x] STEP 4 — src/swarm/server/modelsProvider.warn.test.ts add one test (NO change to modelsProvider.ts)
Finding: warnUnknownConfiguredModels (src/swarm/server/modelsProvider.ts:212-236) compares against the LIVE provider list
(listProviderModels at L221; OpenRouter = https://openrouter.ai/api/v1/models). There is no static list to update. server.ts:138-146
already feeds it ModelRouter.getRecommendedModel(...) for every tier, so the new id is checked automatically.
Append inside the existing describe('warnUnknownConfiguredModels', ...) block, before its closing `});`:

```
  it('recognizes the OpenRouter nemotron instant model from the live list', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'nvidia/nemotron-3-super-120b-a12b:free', pricing: { prompt: '0', completion: '0' } }] }), { status: 200 })));
    const out = await warnUnknownConfiguredModels(
      { openrouter: ['nvidia/nemotron-3-super-120b-a12b:free'] },
      { OPENROUTER_API_KEY: 'k' }
    );
    expect(out).toEqual([]);
  });
```

Acceptance: `npx vitest run src/swarm/server/modelsProvider.warn.test.ts` -> 4 passed.

[x] STEP 5 — test-multi-app-simulation.ts:232 and :490 cosmetic fixture ids (simulated providers; any string works)
BEFORE (L232):

```
            'llama-3-8b',
```

AFTER:

```
            'openai/gpt-oss-20b',
```

BEFORE (L490):

```
        'llama-3.1-8b',
```

AFTER:

```
        'openai/gpt-oss-20b',
```

Acceptance: `npm run test:simulation` passes.

[x] STEP 6 — README.md:17 docs
BEFORE:

```
- 🆓 **100% Free-Tier Calibrated**: Engineered for zero-cost operation across free LLM endpoints (Gemini 2.5 Flash, Groq LLaMA 3.3 70B, OpenRouter free models with automatic `:free` suffix resolution, Mistral Small, and GitHub Models).
```

AFTER:

```
- 🆓 **100% Free-Tier Calibrated**: Engineered for zero-cost operation across free LLM endpoints (Gemini 2.5 Flash, Groq gpt-oss (openai/gpt-oss-120b), OpenRouter free models with automatic `:free` suffix resolution, Mistral Small, and GitHub Models).
```

Acceptance: `git grep -n 'LLaMA 3.3 70B' README.md` prints nothing.

---

## VERIFY (all must pass)

npm run lint
npm run test:unit
npm run test:simulation
npm run build
rg -n 'llama-3.3-70b-instruct' -> MUST print nothing
git status (clean; every step committed)
git log --oneline 7d016ba..HEAD (step 1 … step 6)
git diff --stat 7d016ba
Expected git diff --stat (exactly these 6 files):
src/swarm/router.ts
src/swarm/router.test.ts
src/swarm/router-lifecycle.test.ts
src/swarm/server/modelsProvider.warn.test.ts
test-multi-app-simulation.ts
README.md
PR CHECK: the PR's "Files changed" tab MUST be non-empty and list exactly these 6 files. 0 files = branch not pushed; push it (no rebase/squash).
Not changed on purpose: .omg/ultragoal/audit_v2.md:28, audit_v3.md:39 and src/swarm/providers/adapter.ts:36 mention "LLaMA 3.3" only as
an example of models that emit <think> tags (not a configured id).

DEPLOY (Tyler, after merge): Render redeploys from main; boot log must show no "WARNING: configured openrouter model" line.
