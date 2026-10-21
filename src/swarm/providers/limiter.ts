/**
 * Per-provider limiter + circuit breaker (process memory only).
 * Every provider call made through Agent.run goes through globalProviderLimiter.run().
 * Providers not listed in PROVIDER_LIMITS (simulated, test mocks) pass straight through.
 */

export interface ProviderLimitConfig {
  concurrency: number;
  minSpacingMs: number;
  tokensPerMinute?: number;
  /** Max input tokens a single seat call should send. The seat trims data to fit. */
  maxInputTokens?: number;
}

export const PROVIDER_LIMITS: Record<string, ProviderLimitConfig> = {
  // 7000 TPM. The seat computes the real room per call, so this is only a floor.
  groq: { concurrency: 1, minSpacingMs: 0, tokensPerMinute: 7000, maxInputTokens: 1500 },
  // Free tier is 2 requests a minute. One call has to count, so keep it compact.
  mistral: { concurrency: 1, minSpacingMs: 30000, maxInputTokens: 2000 },
  gemini: { concurrency: 2, minSpacingMs: 0, maxInputTokens: 8000 },
  openrouter: { concurrency: 1, minSpacingMs: 0, maxInputTokens: 6000 },
  nvidia: { concurrency: 2, minSpacingMs: 0, maxInputTokens: 8000 },
  cloudflare: { concurrency: 2, minSpacingMs: 0, maxInputTokens: 6000 },
};

export const BREAKER_FAILURE_THRESHOLD = 3;
export const BREAKER_OPEN_MS = 5 * 60 * 1000;
export const DEAD_MODEL_MS = 24 * 60 * 60 * 1000;
export const MAX_BUDGET_WAIT_MS = 10_000;
export const PROVIDER_CALL_TIMEOUT_MS = 25_000;
export const RETRY_503_BACKOFF_MS = 1_000;
const TOKEN_WINDOW_MS = 60_000;

export class LimiterSkipError extends Error {
  public readonly provider: string;
  public readonly model: string;
  public readonly reason: string;

  constructor(
    provider: string,
    model: string,
    reason: string,
  ) {
    super(
      `[LIMITER_SKIP] ${provider}/${model || "default"} unavailable: ${reason}`,
    );
    this.name = "LimiterSkipError";
    this.provider = provider;
    this.model = model;
    this.reason = reason;
  }
}

/** chars/4 token estimate (same heuristic the Groq adapter uses). */
export function estimateTokens(chars: number): number {
  return Math.ceil(Math.max(0, chars) / 4);
}

export function nextUtcMidnight(nowMs: number): number {
  const d = new Date(nowMs);
  return Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate() + 1,
    0,
    0,
    0,
    0,
  );
}

export type ProviderFailureKind =
  | "daily_quota"
  | "model_dead"
  | "rate_or_server"
  | "other";

export function classifyProviderError(
  provider: string,
  message: string,
): ProviderFailureKind {
  const msg = message || "";
  const lower = msg.toLowerCase();
  if (provider === "openrouter" && lower.includes("free-models-per-day"))
    return "daily_quota";
  if (
    /\b404\b/.test(msg) ||
    msg.includes("NOT_FOUND") ||
    lower.includes("model_not_found")
  )
    return "model_dead";
  if (
    msg.includes("RATE_LIMIT") ||
    /\b429\b/.test(msg) ||
    msg.includes("SERVER_ERROR") ||
    /\b50[0234]\b/.test(msg)
  ) {
    return "rate_or_server";
  }
  return "other";
}

export function is503(message: string): boolean {
  return (
    (message || "").includes("SERVER_ERROR_503") ||
    /\b503\b/.test(message || "")
  );
}

interface ProviderState {
  active: number;
  waiters: Array<() => void>;
  lastStartAt: number;
  consecutiveFailures: number;
  openUntil: number;
  openReason: string;
  tokenLog: Array<{ at: number; tokens: number }>;
}

export interface LimiterRunRequest {
  provider: string;
  model: string;
  estTokens: number;
}

export class ProviderLimiter {
  private states = new Map<string, ProviderState>();
  private deadModels = new Map<string, number>();

  private readonly limits: Record<string, ProviderLimitConfig>;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    limits: Record<
      string,
      ProviderLimitConfig
    > = PROVIDER_LIMITS,
    now: () => number = () => Date.now(),
    sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise<void>((r) => setTimeout(r, ms)),
  ) {
    this.limits = limits;
    this.now = now;
    this.sleep = sleep;
  }

  isManaged(provider: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.limits, provider);
  }

  private state(provider: string): ProviderState {
    let s = this.states.get(provider);
    if (!s) {
      s = {
        active: 0,
        waiters: [],
        lastStartAt: 0,
        consecutiveFailures: 0,
        openUntil: 0,
        openReason: "",
        tokenLog: [],
      };
      this.states.set(provider, s);
    }
    return s;
  }

  /** null = callable now; otherwise why the provider/model is skipped instantly. */
  getSkipReason(provider: string, model?: string): string | null {
    if (!this.isManaged(provider)) return null;
    const t = this.now();
    const s = this.state(provider);
    if (s.openUntil > t) {
      return `circuit open until ${new Date(s.openUntil).toISOString()} (${s.openReason})`;
    }
    if (model) {
      const deadUntil = this.deadModels.get(`${provider}::${model}`);
      if (deadUntil && deadUntil > t) {
        return `model marked dead until ${new Date(deadUntil).toISOString()} (404 model-not-found)`;
      }
    }
    return null;
  }

  /** True when a seat holds this provider's slot. Probes check this and wait. */
  isBusy(provider: string): boolean {
    if (!this.isManaged(provider)) return false;
    return this.state(provider).active > 0;
  }

  isAvailable(provider: string, model?: string): boolean {
    return this.getSkipReason(provider, model) === null;
  }

  recordSuccess(provider: string): void {
    if (!this.isManaged(provider)) return;
    this.state(provider).consecutiveFailures = 0;
  }

  recordFailure(provider: string, model: string, message: string): void {
    if (!this.isManaged(provider)) return;
    const s = this.state(provider);
    const t = this.now();
    const kind = classifyProviderError(provider, message);
    if (kind === "daily_quota") {
      s.openUntil = nextUtcMidnight(t);
      s.openReason = "openrouter free-models-per-day quota exhausted";
      s.consecutiveFailures = 0;
    } else if (kind === "model_dead") {
      if (model)
        this.deadModels.set(`${provider}::${model}`, t + DEAD_MODEL_MS);
    } else if (kind === "rate_or_server") {
      s.consecutiveFailures += 1;
      if (s.consecutiveFailures >= BREAKER_FAILURE_THRESHOLD) {
        s.openUntil = t + BREAKER_OPEN_MS;
        s.openReason = `${s.consecutiveFailures} consecutive 429/5xx`;
        s.consecutiveFailures = 0;
      }
    }
    // 'other' (timeouts, 400s, parse errors) leaves the breaker untouched.
  }

  private tokensUsed(s: ProviderState, t: number): number {
    s.tokenLog = s.tokenLog.filter((e) => t - e.at < TOKEN_WINDOW_MS);
    return s.tokenLog.reduce((sum, e) => sum + e.tokens, 0);
  }

  /** ms until estTokens fits the per-minute budget (0 = fits now, Infinity = can never fit). */
  budgetWaitMs(provider: string, estTokens: number): number {
    const limit = this.limits[provider]?.tokensPerMinute;
    if (!limit) return 0;
    if (estTokens > limit) return Infinity;
    const t = this.now();
    const s = this.state(provider);
    const used = this.tokensUsed(s, t);
    if (used + estTokens <= limit) return 0;
    const mustFree = used + estTokens - limit;
    let freed = 0;
    for (const e of s.tokenLog) {
      freed += e.tokens;
      if (freed >= mustFree) return Math.max(0, e.at + TOKEN_WINDOW_MS - t);
    }
    return Infinity;
  }

  private async acquireSlot(provider: string): Promise<void> {
    const s = this.state(provider);
    const cfg = this.limits[provider];
    while (s.active >= cfg.concurrency) {
      await new Promise<void>((resolve) => s.waiters.push(resolve));
    }
    s.active += 1;
    const spacingWait = s.lastStartAt + cfg.minSpacingMs - this.now();
    if (cfg.minSpacingMs > 0 && spacingWait > 0) {
      await this.sleep(spacingWait);
    }
    s.lastStartAt = this.now();
  }

  private releaseSlot(provider: string): void {
    const s = this.state(provider);
    s.active = Math.max(0, s.active - 1);
    const next = s.waiters.shift();
    if (next) next();
  }

  async run<T>(req: LimiterRunRequest, fn: () => Promise<T>): Promise<T> {
    const { provider, model, estTokens } = req;
    if (!this.isManaged(provider)) return fn();

    const skip = this.getSkipReason(provider, model);
    if (skip) throw new LimiterSkipError(provider, model, skip);

    await this.acquireSlot(provider);
    try {
      const wait = this.budgetWaitMs(provider, estTokens);
      if (wait > MAX_BUDGET_WAIT_MS) {
        throw new LimiterSkipError(
          provider,
          model,
          `token budget needs ${Number.isFinite(wait) ? Math.ceil(wait) + "ms" : "more than a full minute"} of waiting (max ${MAX_BUDGET_WAIT_MS}ms); skipping to next fallback`,
        );
      }
      if (wait > 0) await this.sleep(wait);
      if (this.limits[provider].tokensPerMinute) {
        this.state(provider).tokenLog.push({
          at: this.now(),
          tokens: estTokens,
        });
      }

      let retried503 = false;
      while (true) {
        try {
          const out = await fn();
          this.recordSuccess(provider);
          return out;
        } catch (err: any) {
          const msg = err?.message || String(err);
          if (!retried503 && is503(msg)) {
            retried503 = true; // exactly one backoff retry, 503 only
            await this.sleep(RETRY_503_BACKOFF_MS);
            continue;
          }
          this.recordFailure(provider, model, msg);
          throw err;
        }
      }
    } finally {
      this.releaseSlot(provider);
    }
  }

  /** Clears all breaker/budget state (tests). */
  reset(): void {
    this.states.clear();
    this.deadModels.clear();
  }
}

export const globalProviderLimiter = new ProviderLimiter();
