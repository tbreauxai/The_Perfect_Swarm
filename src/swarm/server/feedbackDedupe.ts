import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const MAX_PROCESSED_FEEDBACK = 10000;

// Track in-flight feedback submissions to prevent concurrent processing of the same feedback
const inFlightFeedbacks = new Set<string>();

export function isFeedbackInFlight(key: string): boolean {
    return inFlightFeedbacks.has(key);
}

export function setFeedbackInFlight(key: string): void {
    inFlightFeedbacks.add(key);
}

export function removeFeedbackInFlight(key: string): void {
    inFlightFeedbacks.delete(key);
}

// Track processed feedback submissions to ensure idempotency
let processedFeedbackSubmissions = new Set<string>();
let persistenceFilePath: string | null = null;
let isPersistent = false;

// Simple string hash function for dedupe key fallback
export function hashString(str: string): string {
    return crypto.createHash('md5').update(str).digest('hex').substring(0, 8);
}

export function generateDedupeKey(callerAppId: string, workflowId: string, pickId: string | undefined, outcome: string, body: any): string {
    if (pickId) {
        return `${callerAppId}:${workflowId}:${pickId}`;
    }

    // Hash relevant fields to create a stable key when pickId is missing
    const hashData = JSON.stringify({
        pickName: body.pickName,
        sportKey: body.sportKey,
        market: body.market,
        predictedProbability: body.predictedProbability
    });
    const hash = hashString(hashData);

    return `${callerAppId}:${workflowId}:${outcome}:${hash}`;
}

export function initFeedbackDedupe(options?: { persistDir?: string }): void {
    const persistDir = options?.persistDir || process.env.RENDER_DISK_PATH;

    if (persistDir) {
        try {
            if (!fs.existsSync(persistDir)) {
                fs.mkdirSync(persistDir, { recursive: true });
            }
            persistenceFilePath = path.join(persistDir, 'processed-feedbacks.json');

            if (fs.existsSync(persistenceFilePath)) {
                const data = fs.readFileSync(persistenceFilePath, 'utf-8');
                const parsed = JSON.parse(data);
                if (Array.isArray(parsed)) {
                    processedFeedbackSubmissions = new Set(parsed);
                }
            }
            isPersistent = true;
        } catch (err) {
            console.warn('[SwarmServer] Failed to initialize persistent feedback dedupe storage, falling back to in-memory:', err);
            isPersistent = false;
        }
    } else {
        console.warn('[SwarmServer] No persistence directory provided (RENDER_DISK_PATH not set), feedback dedupe will be in-memory only and reset on restart.');
        isPersistent = false;
    }
}

function saveProcessedFeedback(): void {
    if (isPersistent && persistenceFilePath) {
        try {
            // Convert Set to Array for JSON serialization
            const data = JSON.stringify(Array.from(processedFeedbackSubmissions));
            // Write to a temporary file first then rename to ensure atomic write
            const tempFile = `${persistenceFilePath}.tmp`;
            fs.writeFileSync(tempFile, data, 'utf-8');
            fs.renameSync(tempFile, persistenceFilePath);
        } catch (err) {
            console.error('[SwarmServer] Failed to save processed feedback submissions to disk:', err);
        }
    }
}

export function isFeedbackProcessed(key: string): boolean {
    return processedFeedbackSubmissions.has(key);
}

export function markFeedbackProcessed(key: string): void {
    processedFeedbackSubmissions.add(key);

    if (processedFeedbackSubmissions.size >= MAX_PROCESSED_FEEDBACK) {
        // Remove oldest to stay under limit
        const oldest = processedFeedbackSubmissions.values().next().value;
        if (oldest) processedFeedbackSubmissions.delete(oldest);
    }

    // Save asynchronously to not block the request
    setTimeout(() => {
        saveProcessedFeedback();
    }, 0);
}

// For testing purposes
export function _resetFeedbackDedupe(): void {
    inFlightFeedbacks.clear();
    processedFeedbackSubmissions.clear();
    isPersistent = false;
    persistenceFilePath = null;
}
