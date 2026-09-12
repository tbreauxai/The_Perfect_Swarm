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
        // Return a deep copy to prevent direct mutation
        return JSON.parse(JSON.stringify(this.data));
    }

    // Only the orchestrator (or whoever holds the lock) can merge drafts
    atomicMerge(ownerId: string, drafts: Record<string, any>[]): boolean {
        if (this.owner !== ownerId || !this.isLocked) {
            throw new Error("Unauthorized: Cannot mutate CentralState without the lock.");
        }

        // Perform atomic merge
        try {
            // Create a backup in case of failure
            const backup = JSON.stringify(this.data);
            
            for (const draft of drafts) {
                // simple deep merge logic for illustration
                this.data = this.deepMerge(this.data, draft);
            }
            
            return true;
        } catch (e) {
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
    private drafts: Record<string, any> = {};

    constructor(public readonly agentId: string) {}

    writeDraft(key: string, data: any) {
        // Agents can only write to their own isolated draft
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
