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
  /** Max milliseconds to wait for sliding token budget before skipping. Default: 65,000ms (strict backpressure). */
  maxBudgetWaitMs?: number;
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
export const MODEL_COOLDOWN_MS = 60_000;
export const DEAD_MODEL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_STRICT_BUDGET_WAIT_MS = 65_000;
export const INTERACTIVE_MAX_BUDGET_WAIT_MS = 10_000;
export const MAX_BUDGET_WAIT_MS = 10_000;
/** Hard cap for failover TPM bucket waits when another healthy provider has <= 5s wait. */
export const FAILOVER_MAX_TPM_WAIT_MS = 5_000;
export const GROQ_MODEL_TPM_LIMITS: Record<string, number> = {
  "openai/gpt-oss-120b": 8_000,
  "openai/gpt-oss-20b": 8_000,
  "llama-3.3-70b-versatile": 12_000,
};
export const UNSATISFIABLE_BUDGET_WAIT_MS = DEFAULT_STRICT_BUDGET_WAIT_MS + 1;
export const PROMPT_EXCEEDS_LIMIT_REASON = "prompt_exceeds_provider_limit";
export const PROVIDER_CALL_TIMEOUT_MS = 25_000;
export const RETRY_503_BACKOFF_MS = 1_000;
export const GEMINI_503_RETRY_MIN_MS = 1_200;
export const GEMINI_503_RETRY_MAX_MS = 2_000;
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

import { TokenEstimator } from "../compression/tokenEstimator.ts";

/**
 * Estimates token count for numeric character counts, text strings, or structured payload objects.
 * Numeric character counts fall back to chars/4 for backwards compatibility.
 * Text strings and structured objects use syntax-aware parsing with a 1.12x JSON safety buffer.
 */
export function estimateTokens(input: number | string | object | unknown): number {
  if (typeof input === "number") {
    return TokenEstimator.estimateFromChars(input);
  }
  return TokenEstimator.estimatePayloadTokens(input);
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
  | "rate_limit"
  | "server_error"
  | "rate_or_server"
  | "other";

export function isExplicitDailyRpdError(message: string): boolean {
  return /free-models-per-day|per[\s_-]*day|daily\s+(?:limit|quota|cap)|requests?\s+per\s+day|\brpd\b/i.test(
    message || "",
  );
}

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
    lower.includes("resource_exhausted") ||
    lower.includes("rate limit") ||
    lower.includes("quota exceeded")
  ) {
    return "rate_limit";
  }
  if (
    msg.includes("SERVER_ERROR") ||
    /\b50[0234]\b/.test(msg) ||
    /\b500\b/.test(msg) ||
    lower.includes("overloaded") ||
    lower.includes("high demand")
  ) {
    return "server_error";
  }
  return "other";
}

export function is503(message: string): boolean {
  const msg = message || "";
  const lower = msg.toLowerCase();
  return (
    msg.includes("SERVER_ERROR_503") ||
    /\b503\b/.test(msg) ||
    lower.includes("overloaded") ||
    lower.includes("high demand")
  );
}

export function isTransientGeminiRetryable(message: string): boolean {
  const msg = message || "";
  return is503(msg) || msg.includes("SERVER_ERROR_500") || /\b500\b/.test(msg);
}

export function computeGemini503JitterMs(rand: () => number = Math.random): number {
  const span = GEMINI_503_RETRY_MAX_MS - GEMINI_503_RETRY_MIN_MS;
  return GEMINI_503_RETRY_MIN_MS + Math.floor(Math.max(0, Math.min(1, rand())) * (span + 1));
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
  maxBudgetWaitMs?: number;
}

export class ProviderLimiter {
  private states = new Map<string, ProviderState>();
  private modelTokenLogs = new Map<string, Array<{ at: number; tokens: number }>>();
  private deadModels = new Map<string, number>();
  private modelCooldowns = new Map<string, { until: number; reason: string }>();

  private readonly limits: Record<string, ProviderLimitConfig>;
  private readonly hasCustomLimits: boolean;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    limits?: Record<string, ProviderLimitConfig>,
    now: () => number = () => Date.now(),
    sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise<void>((r) => setTimeout(r, ms)),
  ) {
    this.hasCustomLimits = limits !== undefined;
    this.limits = limits ?? PROVIDER_LIMITS;
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
      const key = `${provider}::${model}`;
      const deadUntil = this.deadModels.get(key);
      if (deadUntil && deadUntil > t) {
        return `model marked dead until ${new Date(deadUntil).toISOString()} (404 model-not-found)`;
      }
      const cooldown = this.modelCooldowns.get(key);
      if (cooldown && cooldown.until > t) {
        return `model on cooldown until ${new Date(cooldown.until).toISOString()} (${cooldown.reason})`;
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

  recordSuccess(provider: string, model?: string): void {
    if (!this.isManaged(provider)) return;
    this.state(provider).consecutiveFailures = 0;
    if (model) {
      this.modelCooldowns.delete(`${provider}::${model}`);
    }
  }

  recordFailure(provider: string, model: string, message: string, isFinalAttempt: boolean = true): void {
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
    } else if (provider === "gemini" && model) {
      // S3: Per-model runtime cooldown on Gemini 503/500/429 without marking unrelated siblings unhealthy.
      if (isExplicitDailyRpdError(message)) {
        this.modelCooldowns.set(`${provider}::${model}`, {
          until: nextUtcMidnight(t),
          reason: "daily RPD quota exhausted",
        });
      } else if (
        kind === "server_error" ||
        kind === "rate_or_server" ||
        (kind === "rate_limit" && isFinalAttempt)
      ) {
        this.modelCooldowns.set(`${provider}::${model}`, {
          until: t + MODEL_COOLDOWN_MS,
          reason:
            kind === "rate_limit"
              ? "429 RPM rate limit"
              : "503/500 transient overload",
        });
      }
    } else if (kind === "server_error" || kind === "rate_or_server") {
      s.consecutiveFailures += 1;
      if (s.consecutiveFailures >= BREAKER_FAILURE_THRESHOLD) {
        s.openUntil = t + BREAKER_OPEN_MS;
        s.openReason = `${s.consecutiveFailures} consecutive 5xx server errors`;
        s.consecutiveFailures = 0;
      }
    } else if (kind === "rate_limit") {
      if (isFinalAttempt) {
        s.consecutiveFailures += 1;
        if (s.consecutiveFailures >= BREAKER_FAILURE_THRESHOLD) {
          s.openUntil = t + BREAKER_OPEN_MS;
          s.openReason = `${s.consecutiveFailures} consecutive 429 rate limit errors (retries exhausted)`;
          s.consecutiveFailures = 0;
        }
      }
    }
    // 'other' (timeouts, 400s, parse errors) leaves the breaker untouched.
  }

  getMaxBudgetWaitMs(provider: string, requestWaitMs?: number): number {
    if (typeof requestWaitMs === "number" && requestWaitMs > 0) {
      return requestWaitMs;
    }
    const cfgWait = this.limits[provider]?.maxBudgetWaitMs;
    if (typeof cfgWait === "number" && cfgWait > 0) {
      return cfgWait;
    }
    return MAX_BUDGET_WAIT_MS;
  }

  private getTokenLimit(provider: string, model?: string): number | undefined {
    const cfg = this.limits[provider];
    if (!cfg || cfg.tokensPerMinute === undefined) return undefined;
    if (provider === "groq" && model && !this.hasCustomLimits) {
      const normModel = model.trim().toLowerCase();
      if (normModel === "llama-3.3-70b-versatile") {
        return GROQ_MODEL_TPM_LIMITS["llama-3.3-70b-versatile"];
      }
      // Keep the conservative 7,000 TPM floor for 8K-TPM Groq models (gpt-oss-120b, gpt-oss-20b)
      return cfg.tokensPerMinute;
    }
    return cfg.tokensPerMinute;
  }

  private getTokenLog(provider: string, model?: string): Array<{ at: number; tokens: number }> {
    if (provider === "groq" && model && model.trim()) {
      const key = `groq::${model.trim().toLowerCase()}`;
      let log = this.modelTokenLogs.get(key);
      if (!log) {
        log = [];
        this.modelTokenLogs.set(key, log);
      }
      return log;
    }
    return this.state(provider).tokenLog;
  }

  private setTokenLog(provider: string, model: string | undefined, log: Array<{ at: number; tokens: number }>): void {
    if (provider === "groq" && model && model.trim()) {
      this.modelTokenLogs.set(`groq::${model.trim().toLowerCase()}`, log);
      return;
    }
    this.state(provider).tokenLog = log;
  }

  /** True when the request can never fit into the provider's bucket capacity or refill rate <= 0. */
  exceedsTokenBudgetCapacity(provider: string, estTokens: number, model?: string): boolean {
    const limit = this.getTokenLimit(provider, model);
    if (limit === undefined) return false;
    const tokensPerMs = limit / TOKEN_WINDOW_MS;
    if (!Number.isFinite(limit) || limit <= 0 || tokensPerMs <= 0) return true;
    return !Number.isFinite(estTokens) || estTokens > limit;
  }

  private tokensUsed(provider: string, model: string | undefined, t: number): number {
    const fresh = this.getTokenLog(provider, model).filter((e) => t - e.at < TOKEN_WINDOW_MS);
    this.setTokenLog(provider, model, fresh);
    return fresh.reduce((sum, e) => sum + e.tokens, 0);
  }

  /**
   * Finite ms until estTokens fits the per-minute budget (0 = fits now).
   * Never returns Infinity or NaN; returns UNSATISFIABLE_BUDGET_WAIT_MS when
   * requestedTokens > bucketCapacity or tokensPerMs <= 0.
   * For Groq, token windows are tracked independently per `(provider, model)`.
   */
  budgetWaitMs(provider: string, estTokens: number, model?: string): number {
    const limit = this.getTokenLimit(provider, model);
    if (limit === undefined) return 0;
    const tokensPerMs = limit / TOKEN_WINDOW_MS;
    if (!Number.isFinite(limit) || limit <= 0 || tokensPerMs <= 0) {
      return UNSATISFIABLE_BUDGET_WAIT_MS;
    }
    if (!Number.isFinite(estTokens) || estTokens > limit) {
      return UNSATISFIABLE_BUDGET_WAIT_MS;
    }
    const t = this.now();
    const used = this.tokensUsed(provider, model, t);
    if (used + estTokens <= limit) return 0;
    const mustFree = used + estTokens - limit;
    let freed = 0;
    const log = this.getTokenLog(provider, model);
    for (const e of log) {
      freed += e.tokens;
      if (freed >= mustFree) return Math.max(0, e.at + TOKEN_WINDOW_MS - t);
    }
    return TOKEN_WINDOW_MS;
  }

  private async acquireSlot(provider: string, model: string = "default", maxWaitMs: number = 60_000): Promise<void> {
    const s = this.state(provider);
    const cfg = this.limits[provider];
    while (s.active >= cfg.concurrency) {
      let timer: any;
      let waiterResolve: (() => void) | null = null;
      try {
        await new Promise<void>((resolve, reject) => {
          waiterResolve = resolve;
          s.waiters.push(resolve);
          timer = setTimeout(() => {
            const idx = s.waiters.indexOf(waiterResolve!);
            if (idx !== -1) s.waiters.splice(idx, 1);
            reject(new LimiterSkipError(provider, model, 'slot_wait_timeout'));
          }, maxWaitMs);
        });
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    s.active += 1;
    const isTest = typeof process !== "undefined" && !!process.env.VITEST;
    const effectiveSpacing = isTest ? 0 : cfg.minSpacingMs;
    const spacingWait = s.lastStartAt + effectiveSpacing - this.now();
    if (effectiveSpacing > 0 && spacingWait > 0) {
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

    if (this.exceedsTokenBudgetCapacity(provider, estTokens, model)) {
      throw new LimiterSkipError(provider, model, PROMPT_EXCEEDS_LIMIT_REASON);
    }

    await this.acquireSlot(provider, model, req.maxBudgetWaitMs ?? 60_000);
    try {
      const maxBudgetWait = this.getMaxBudgetWaitMs(provider, req.maxBudgetWaitMs);
      const wait = this.budgetWaitMs(provider, estTokens, model);
      if (!Number.isFinite(wait) || wait >= UNSATISFIABLE_BUDGET_WAIT_MS) {
        throw new LimiterSkipError(provider, model, PROMPT_EXCEEDS_LIMIT_REASON);
      }
      if (wait > maxBudgetWait) {
        throw new LimiterSkipError(
          provider,
          model,
          `skipped_tpm_wait: ${Math.ceil(wait)}ms (max ${maxBudgetWait}ms); skipping to next fallback`,
        );
      }
      if (wait > 0) await this.sleep(wait);
      if (this.getTokenLimit(provider, model) !== undefined) {
        this.getTokenLog(provider, model).push({
          at: this.now(),
          tokens: estTokens,
        });
      }

      let retried503 = false;
      while (true) {
        try {
          const out = await fn();
          this.recordSuccess(provider, model);
          return out;
        } catch (err: any) {
          const msg = err?.message || String(err);
          const canRetry =
            !retried503 &&
            (provider === "gemini" ? isTransientGeminiRetryable(msg) : is503(msg));
          if (canRetry) {
            retried503 = true; // exactly one fast retry on transient 503/500/overloaded
            const backoffMs =
              provider === "gemini"
                ? computeGemini503JitterMs()
                : RETRY_503_BACKOFF_MS;
            await this.sleep(backoffMs);
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

  /** Drop sliding TPM windows only (keep circuits / dead-model marks). Morning clears between games. */
  clearTokenLogs(): void {
    for (const st of this.states.values()) {
      st.tokenLog.length = 0;
    }
    this.modelTokenLogs.clear();
  }

  /** Clears all breaker/budget/cooldown state (tests). */
  reset(): void {
    this.states.clear();
    this.modelTokenLogs.clear();
    this.deadModels.clear();
    this.modelCooldowns.clear();
  }
}

export const globalProviderLimiter = new ProviderLimiter();
