import type { AnalystLedgerRecord } from './types.ts';
import { QdrantLearningStore } from '../learning-persistence.ts';
export class AnalystLedger {
  public records = new Map<string, AnalystLedgerRecord>();
  private persistPath?: string;
  private autoSave: boolean = false;
  private debounceMs: number = 250;
  private saveTimeout: any = null;
  private learningStore: QdrantLearningStore | null = null;

  constructor(config?: { persistPath?: string; autoSave?: boolean; debounceMs?: number }) {
    if (config?.persistPath) this.persistPath = config.persistPath;
    if (config?.autoSave !== undefined) this.autoSave = config.autoSave;
    if (config?.debounceMs !== undefined) this.debounceMs = config.debounceMs;
  }

  /** Attach durable persistence (Qdrant). Writes become fire-and-forget; reads stay in-memory. */
  public setLearningStore(store: QdrantLearningStore | null): void {
    this.learningStore = store;
  }

  public getLearningStore(): QdrantLearningStore | null {
    return this.learningStore;
  }

  /**
   * Restore ledger entries from durable storage. Merges with any in-memory
   * entries by taking the max of each counter (safe against double-restore).
   * Returns the number of keys restored.
   */
  public async restoreFromLearningStore(): Promise<number> {
    if (!this.learningStore) return 0;
    const state = await this.learningStore.loadAll();
    return this.import(state.ledger);
  }

  public recordOutcome(appId: string, agentRole: string, outcome: 'win' | 'loss' | 'push'): void {
    const key = `${appId}:${agentRole}`;
    const record = this.records.get(key) || { wins: 0, losses: 0, pushes: 0, lastUpdated: 0 };
    
    if (outcome === 'win') record.wins += 1;
    else if (outcome === 'loss') record.losses += 1;
    else if (outcome === 'push') record.pushes += 1;
    
    record.lastUpdated = Date.now();
    this.records.set(key, record);

    if (this.learningStore) {
      this.learningStore.saveLedgerEntry(key, record as unknown as Record<string, any>)
        .catch((err) => console.warn('[AnalystLedger] Ledger persist failed:', err?.message || err));
    }

    if (this.autoSave && this.persistPath) {
      this.scheduleAutoSave();
    }
  }

  public getMetrics(): Record<string, AnalystLedgerRecord> {
    return Object.fromEntries(this.records);
  }

  public getRecord(appId: string, agentRole: string): AnalystLedgerRecord | undefined {
    return this.records.get(`${appId}:${agentRole}`);
  }

  public getAverageAccuracy(appId: string, agentRoles: string[]): { accuracy: number; totalOutcomes: number } {
    let totalWins = 0;
    let totalLosses = 0;
    let totalPushes = 0;

    for (const role of agentRoles) {
      const rec = this.getRecord(appId, role);
      if (rec) {
        totalWins += rec.wins;
        totalLosses += rec.losses;
        totalPushes += rec.pushes;
      }
    }

    const total = totalWins + totalLosses + totalPushes;
    if (total === 0) {
      return { accuracy: 0.5, totalOutcomes: 0 };
    }

    const accuracy = (totalWins + 0.5 * totalPushes) / total;
    return { accuracy: Math.round(accuracy * 1000) / 1000, totalOutcomes: total };
  }

  public clear(): void {
    this.records.clear();
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }
  }

  public setPersistPath(path: string, autoSave: boolean = true): void {
    this.persistPath = path;
    this.autoSave = autoSave;
  }

  public getPersistPath(): string | undefined {
    return this.persistPath;
  }

  public isAutoSaveEnabled(): boolean {
    return this.autoSave;
  }

  public export(): Record<string, AnalystLedgerRecord> {
    return Object.fromEntries(this.records);
  }

  public import(data: Record<string, Partial<AnalystLedgerRecord>> | string): number {
    let parsed: Record<string, any>;
    if (typeof data === 'string') {
      try {
        parsed = JSON.parse(data);
      } catch (err: any) {
        console.warn('[AnalystLedger] Failed to parse import JSON:', err);
        return 0;
      }
    } else {
      parsed = data;
    }

    let count = 0;
    for (const [key, val] of Object.entries(parsed)) {
      if (!val || typeof val !== 'object') continue;
      const existing = this.records.get(key) || { wins: 0, losses: 0, pushes: 0, lastUpdated: 0 };
      existing.wins = Math.max(existing.wins, Number(val.wins || 0));
      existing.losses = Math.max(existing.losses, Number(val.losses || 0));
      existing.pushes = Math.max(existing.pushes, Number(val.pushes || 0));
      existing.lastUpdated = Math.max(existing.lastUpdated, Number(val.lastUpdated || Date.now()));
      this.records.set(key, existing);
      count++;
    }
    return count;
  }

  public async saveToFile(filePath?: string): Promise<boolean> {
    const target = filePath || this.persistPath;
    if (!target) return false;

    try {
      const fs = await import('no' + 'de:fs');
      const path = await import('no' + 'de:path');
      const dir = path.dirname(target);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const data = JSON.stringify(this.export(), null, 2);
      fs.writeFileSync(target, data, 'utf-8');
      return true;
    } catch (err: any) {
      console.warn(`[AnalystLedger] Failed to save to file '${target}':`, err?.message || err);
      return false;
    }
  }

  public async loadFromFile(filePath?: string): Promise<boolean> {
    const target = filePath || this.persistPath;
    if (!target) return false;

    try {
      const fs = await import('no' + 'de:fs');
      if (!fs.existsSync(target)) return false;
      const raw = fs.readFileSync(target, 'utf-8');
      this.import(raw);
      return true;
    } catch (err: any) {
      console.warn(`[AnalystLedger] Failed to load from file '${target}':`, err?.message || err);
      return false;
    }
  }

  private scheduleAutoSave(): void {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
    }
    this.saveTimeout = setTimeout(() => {
      this.saveToFile().catch(() => {});
    }, this.debounceMs);
  }
}

export const analystLedger = new AnalystLedger();


