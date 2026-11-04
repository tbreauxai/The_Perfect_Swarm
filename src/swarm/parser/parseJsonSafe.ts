import type { ValidationOutcome } from './types.ts';
import { repairJson, extractFuzzyFields } from './repairJson.ts';

export interface ParseJsonSafeResult<T> {
    data: T;
    repaired: boolean;
}

/**
 * Parses JSON safely from any input while tracking whether format repair was required.
 */
export function parseJsonSafeWithStatus<T = any>(input: unknown, fallback?: T): ParseJsonSafeResult<T> {
    if (typeof input === 'object' && input !== null) {
        return { data: input as T, repaired: false };
    }
    if (typeof input !== 'string') {
        return { data: (fallback !== undefined ? fallback : {}) as T, repaired: true };
    }

    const trimmed = input.trim();
    if (!trimmed) {
        return { data: (fallback !== undefined ? fallback : {}) as T, repaired: true };
    }

    // Attempt 1: Direct JSON.parse
    try {
        return { data: JSON.parse(trimmed) as T, repaired: false };
    } catch {
        // continue
    }

    // Attempt 2: Direct outer substring slice
    try {
        const firstObj = trimmed.indexOf('{');
        const lastObj = trimmed.lastIndexOf('}');
        if (firstObj !== -1 && lastObj > firstObj) {
            const sliced = JSON.parse(trimmed.substring(firstObj, lastObj + 1)) as T;
            return { data: sliced, repaired: true };
        }
    } catch {
        // continue
    }

    // Attempt 3: Resilient JSON repair (if JSON container brackets exist)
    if (trimmed.includes('{') || trimmed.includes('[')) {
        try {
            const repaired = repairJson(trimmed);
            const parsed = JSON.parse(repaired) as T;
            if (parsed && (typeof parsed !== 'object' || Object.keys(parsed).length > 0)) {
                return { data: parsed, repaired: true };
            }
        } catch {
            // continue
        }
    }

    // Attempt 4: Fuzzy regex extraction
    const fuzzy = extractFuzzyFields(trimmed);
    if (fuzzy && Object.keys(fuzzy).length > 0) {
        return { data: fuzzy as T, repaired: true };
    }

    return { data: (fallback !== undefined ? fallback : {}) as T, repaired: true };
}

/**
 * Parses JSON safely from any input (object, string, malformed string, or buffer).
 * Never throws under any circumstances.
 */
export function parseJsonSafe<T = any>(input: unknown, fallback?: T): T {
    return parseJsonSafeWithStatus<T>(input, fallback).data;
}

/**
 * Generic schema guard and auto-repair validator.
 */
export function repairAndValidate<T>(
    input: unknown,
    schema: { safeParse: (data: unknown) => { success: true; data: T } | { success: false; error: any } },
    fallbackFactory?: (raw: any, errors: string[]) => T
): ValidationOutcome<T> {
    const raw = parseJsonSafe(input);
    let repaired = false;

    // 1. Initial validation
    const firstCheck = schema.safeParse(raw);
    if (firstCheck.success) {
        return { success: true, data: firstCheck.data, repaired: false };
    }

    // 2. Intelligent Auto-Coercion
    const coerced: any = Array.isArray(raw) ? [...raw] : { ...raw };

    // Coerce single string into array if array was expected
    for (const key of Object.keys(coerced)) {
        const val = coerced[key];
        if (typeof val === 'string' && (key.endsWith('s') || key === 'insights' || key === 'anomalies' || key === 'components')) {
            if (val.includes('\n')) {
                coerced[key] = val.split('\n').map((l: string) => l.replace(/^[-*•\d.]+\s*/, '').trim()).filter((l: string) => l.length > 0);
                repaired = true;
            }
        }
    }

    const secondCheck = schema.safeParse(coerced);
    if (secondCheck.success) {
        return { success: true, data: secondCheck.data, repaired: true };
    }

    // 3. Fallback Factory
    const scAny = secondCheck as any;
    const errorList = (scAny.error?.issues || scAny.error?.errors || []).map((e: any) => `${e.path?.join('.')}: ${e.message}`);

    if (fallbackFactory) {
        return {
            success: true,
            data: fallbackFactory(raw, errorList),
            repaired: true,
            errors: errorList
        };
    }

    return {
        success: false,
        data: coerced as T,
        repaired: true,
        errors: errorList
    };
}
