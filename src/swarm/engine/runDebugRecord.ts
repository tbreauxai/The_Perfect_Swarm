const MAX_RUN_DEBUG_RECORDS = 10;

export interface RunDebugEdit {
  check: string;
  before?: string;
  after?: string;
  reason: string;
}

export interface RunDebugVerdict {
  pass: boolean;
  flags?: string[];
}

export interface RunDebugSeatRecord {
  seat: string;
  role: string;
  provider: string;
  model?: string;
  promptChars: number;
  limitChars: number;
  headerChars?: number;
  headerBudget?: number;
  pricedHeaders?: number;
  postFailoverProvider?: string;
  postFailoverLimitChars?: number;
  toolResultsSent?: string;
  outputDigest?: string;
  verdict?: RunDebugVerdict;
  droppedBlocks: string[];
  edits: RunDebugEdit[];
}

export interface RunDebugRecord {
  workflowId: string;
  createdAt: string;
  agreementLevel?: string;
  seats: Record<string, RunDebugSeatRecord>;
}

const runDebugRing = new Map<string, RunDebugRecord>();

export function isRunDebugEnabled(): boolean {
  return typeof process !== 'undefined' && process.env?.SWARM_RUN_DEBUG === '1';
}

function scrubKeyLikeStrings(text: string): string {
  if (!text) return '';
  return text
    .replace(/\b(?:sk-[a-zA-Z0-9_-]{12,}|gsk_[a-zA-Z0-9_-]{12,}|AIza[0-9A-Za-z_-]{20,}|AQ\.[0-9A-Za-z._-]{15,}|ghp_[0-9A-Za-z]{20,})\b/g, '[REDACTED]')
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|authorization|token|secret)\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1[REDACTED]');
}

function ensureRecord(workflowId: string): RunDebugRecord {
  let rec = runDebugRing.get(workflowId);
  if (rec) return rec;
  if (runDebugRing.size >= MAX_RUN_DEBUG_RECORDS) {
    const oldestKey = runDebugRing.keys().next().value;
    if (oldestKey !== undefined) {
      runDebugRing.delete(oldestKey);
    }
  }
  rec = {
    workflowId,
    createdAt: new Date().toISOString(),
    seats: {}
  };
  runDebugRing.set(workflowId, rec);
  return rec;
}

function ensureSeat(rec: RunDebugRecord, seatKey: string, defaults?: Partial<RunDebugSeatRecord>): RunDebugSeatRecord {
  let seat = rec.seats[seatKey];
  if (!seat) {
    seat = {
      seat: seatKey,
      role: defaults?.role || seatKey,
      provider: defaults?.provider || 'unknown',
      promptChars: 0,
      limitChars: 0,
      droppedBlocks: [],
      edits: []
    };
    rec.seats[seatKey] = seat;
  }
  return seat;
}

export function recordRunDebugSeat(
  workflowId: string | undefined,
  seatKey: string,
  data: Partial<RunDebugSeatRecord>
): void {
  if (!isRunDebugEnabled() || !workflowId || !seatKey) return;
  const rec = ensureRecord(workflowId);
  const seat = ensureSeat(rec, seatKey, data);
  if (data.role) seat.role = data.role;
  if (data.provider) seat.provider = data.provider;
  if (data.model) seat.model = data.model;
  if (typeof data.promptChars === 'number') seat.promptChars = data.promptChars;
  if (typeof data.limitChars === 'number') seat.limitChars = data.limitChars;
  if (typeof data.headerChars === 'number') seat.headerChars = data.headerChars;
  if (typeof data.headerBudget === 'number') seat.headerBudget = data.headerBudget;
  if (typeof data.pricedHeaders === 'number') seat.pricedHeaders = data.pricedHeaders;
  if (data.postFailoverProvider) seat.postFailoverProvider = data.postFailoverProvider;
  if (typeof data.postFailoverLimitChars === 'number') seat.postFailoverLimitChars = data.postFailoverLimitChars;
  if (typeof data.toolResultsSent === 'string') {
    seat.toolResultsSent = scrubKeyLikeStrings(data.toolResultsSent);
  }
  if (typeof data.outputDigest === 'string') {
    seat.outputDigest = scrubKeyLikeStrings(data.outputDigest).slice(0, 600);
  }
  if (data.verdict && typeof data.verdict === 'object' && typeof data.verdict.pass === 'boolean') {
    seat.verdict = {
      pass: data.verdict.pass,
      ...(Array.isArray(data.verdict.flags)
        ? { flags: data.verdict.flags.map(f => scrubKeyLikeStrings(String(f))) }
        : {})
    };
  }
  if (Array.isArray(data.droppedBlocks)) {
    for (const b of data.droppedBlocks) {
      const clean = scrubKeyLikeStrings(b);
      if (clean && !seat.droppedBlocks.includes(clean)) seat.droppedBlocks.push(clean);
    }
  }
  if (Array.isArray(data.edits)) {
    for (const e of data.edits) {
      seat.edits.push({
        check: e.check,
        ...(e.before !== undefined ? { before: scrubKeyLikeStrings(e.before).slice(0, 240) } : {}),
        ...(e.after !== undefined ? { after: scrubKeyLikeStrings(e.after).slice(0, 240) } : {}),
        reason: scrubKeyLikeStrings(e.reason)
      });
    }
  }
}

export function recordRunDebugDrop(
  workflowId: string | undefined,
  seatKey: string,
  blockLabel: string
): void {
  if (!isRunDebugEnabled() || !workflowId || !seatKey || !blockLabel) return;
  recordRunDebugSeat(workflowId, seatKey, { droppedBlocks: [blockLabel] });
}

export function recordRunDebugEdit(
  workflowId: string | undefined,
  seatKey: string,
  edit: RunDebugEdit
): void {
  if (!isRunDebugEnabled() || !workflowId || !seatKey) return;
  recordRunDebugSeat(workflowId, seatKey, { edits: [edit] });
}

function canonicalFailoverSeatKey(seatKey: string): string {
  const s = seatKey.trim();
  if (/verifier/i.test(s)) return 'verifier';
  if (/critic/i.test(s)) return 'critic';
  if (/manager/i.test(s)) return 'manager';
  if (/(^a1$|quant)/i.test(s)) return 'a1';
  if (/(^a2$|market)/i.test(s)) return 'a2';
  return seatKey;
}

export function recordRunDebugFailover(
  workflowId: string | undefined,
  seatKey: string,
  provider: string,
  limitChars: number
): void {
  if (!isRunDebugEnabled() || !workflowId || !seatKey) return;
  recordRunDebugSeat(workflowId, canonicalFailoverSeatKey(seatKey), {
    postFailoverProvider: provider,
    postFailoverLimitChars: limitChars
  });
}

export function formatRunDebugOutputDigest(output: unknown): string {
  if (output === null || output === undefined) return '';
  let raw = '';
  if (typeof output === 'string') {
    raw = output;
  } else {
    try {
      raw = JSON.stringify(output);
    } catch {
      raw = String(output);
    }
  }
  return scrubKeyLikeStrings(raw).slice(0, 600);
}

export function recordRunDebugAgreement(
  workflowId: string | undefined,
  agreementLevel: string | undefined
): void {
  if (!isRunDebugEnabled() || !workflowId || !agreementLevel) return;
  const rec = ensureRecord(workflowId);
  rec.agreementLevel = scrubKeyLikeStrings(agreementLevel);
}

export function getRunDebugRecord(workflowId: string): RunDebugRecord | undefined {
  if (!isRunDebugEnabled() || !workflowId) return undefined;
  return runDebugRing.get(workflowId);
}

export function getRunDebugRingIds(): string[] {
  return Array.from(runDebugRing.keys());
}

export function clearRunDebugRecords(): void {
  runDebugRing.clear();
}
