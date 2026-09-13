export class CentralState {
    private data: Record<string, any> = {};
    private isLocked: boolean = false;
    private owner: string | null = null;

    acquireLock(ownerId: string): boolean {
        if (!this.isLocked) {
            this.isLocked = true;
            this.owner = ownerId;
            return true;
        }
        return this.owner === ownerId;
    }

    releaseLock(ownerId: string): void {
        if (this.owner === ownerId) {
            this.isLocked = false;
            this.owner = null;
        }
    }

    read(): Record<string, any> {
        return JSON.parse(JSON.stringify(this.data));
    }

    atomicMerge(ownerId: string, drafts: Record<string, any>[]): boolean {
        if (this.owner !== ownerId || !this.isLocked) {
            throw new Error("Unauthorized: Cannot mutate CentralState without the lock.");
        }

        try {
            for (const draft of drafts) {
                this.data = this.deepMerge(this.data, draft);
            }
            return true;
        } catch {
            console.error("Merge failed, rolling back.");
            return false;
        }
    }

    private deepMerge(target: any, source: any): any {
        if (typeof target !== 'object' || target === null) return source;
        if (typeof source !== 'object' || source === null) return source;

        const output = { ...target };
        for (const key of Object.keys(source)) {
            if (source[key] instanceof Object) {
                if (!(key in target)) Object.assign(output, { [key]: source[key] });
                else output[key] = this.deepMerge(target[key], source[key]);
            } else {
                Object.assign(output, { [key]: source[key] });
            }
        }
        return output;
    }
}

export class DraftFolder {
    public readonly agentId: string;
    private drafts: Record<string, any> = {};

    constructor(agentId: string) {
        this.agentId = agentId;
    }

    writeDraft(key: string, data: any) {
        this.drafts[key] = data;
    }

    readDraft(key: string): any {
        return this.drafts[key];
    }

    getAllDrafts(): Record<string, any> {
        return { ...this.drafts };
    }

    clear() {
        this.drafts = {};
    }
}
