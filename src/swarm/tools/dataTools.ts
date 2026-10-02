import type { SwarmTool } from './types.ts';

/**
 * Extracts values from JSON using dot/bracket path syntax.
 */
export function extractJsonPath(data: any, path: string): { found: boolean; value: any } {
    if (data === null || data === undefined) return { found: false, value: undefined };
    if (!path || path.trim() === '' || path === '.') return { found: true, value: data };

    const segments = path.replace(/\[(\w+)\]/g, '.$1').replace(/^\./, '').split('.');
    let curr = data;

    for (const segment of segments) {
        if (curr === null || curr === undefined) {
            return { found: false, value: undefined };
        }
        if (typeof curr === 'object' && segment in curr) {
            curr = curr[segment];
        } else {
            return { found: false, value: undefined };
        }
    }

    return { found: true, value: curr };
}

/**
 * Built-in JSON extraction tool.
 */
export const jsonExtractTool: SwarmTool<
    { data: any; path: string },
    { found: boolean; path: string; value: any }
> = {
    name: 'json_extract',
    description: 'Extracts deep properties from a JSON string or object using dot/bracket paths (e.g. "users[0].profile.email").',
    parameters: {
        data: {
            type: 'object',
            description: 'JSON object, array, or valid JSON string',
            required: true
        },
        path: {
            type: 'string',
            description: 'Dot/bracket notation path to extract (e.g. "metrics.cpu.load[0]")',
            required: true
        }
    },
    execute({ data, path }) {
        let parsed = data;
        if (typeof data === 'string') {
            try {
                parsed = JSON.parse(data);
            } catch (err: any) {
                throw new Error(`json_extract failed to parse string as JSON: ${err.message}`);
            }
        }
        const { found, value } = extractJsonPath(parsed, path);
        return { found, path, value };
    }
};

/**
 * Built-in data filtering and querying tool.
 */
export const dataFilterTool: SwarmTool<
    { items?: any[]; data?: any[]; field?: string; filter?: { field?: string; operator?: string; value?: any }; operator?: '==' | '!=' | '>' | '>=' | '<' | '<=' | 'contains' | 'in'; value?: any; limit?: number; sortBy?: string; sortOrder?: 'asc' | 'desc' },
    { matchedCount: number; totalCount: number; results: any[]; data: any[] }
> = {
    name: 'data_filter',
    description: 'Filters an array of JSON objects based on condition operators (==, !=, >, >=, <, <=, contains, in).',
    parameters: {
        items: {
            type: 'array',
            description: 'Array of objects to filter',
            required: true
        },
        field: {
            type: 'string',
            description: 'Field path to test (e.g. "status", "metrics.cpu")',
            required: true
        },
        operator: {
            type: 'string',
            description: 'Comparison operator: "==", "!=", ">", ">=", "<", "<=", "contains", "in" (default: "==")',
            required: false
        },
        value: {
            type: 'string',
            description: 'Value to compare against',
            required: true
        },
        limit: {
            type: 'number',
            description: 'Maximum number of items to return',
            required: false
        }
    },
    execute(rawParams: any) {
        const items = rawParams.items || rawParams.data;
        const field = rawParams.field || rawParams.filter?.field;
        const operator = rawParams.operator || rawParams.filter?.operator || '==';
        const value = rawParams.value !== undefined ? rawParams.value : rawParams.filter?.value;
        const limit = rawParams.limit;
        const sortBy = rawParams.sortBy;
        const sortOrder = rawParams.sortOrder || 'asc';

        let array = items;
        if (typeof items === 'string') {
            try {
                array = JSON.parse(items);
            } catch {
                throw new Error('data_filter: items must be an array of objects.');
            }
        }
        if (!Array.isArray(array)) {
            throw new Error('data_filter requires an array of items.');
        }

        let filtered = array.filter(item => {
            const { found, value: itemVal } = extractJsonPath(item, field);
            if (!found) return operator === '!=' || (operator === '==' && value === undefined);

            switch (operator) {
                case '==':
                    return itemVal == value;
                case '!=':
                    return itemVal != value;
                case '>':
                    return Number(itemVal) > Number(value);
                case '>=':
                    return Number(itemVal) >= Number(value);
                case '<':
                    return Number(itemVal) < Number(value);
                case '<=':
                    return Number(itemVal) <= Number(value);
                case 'contains':
                    return String(itemVal).toLowerCase().includes(String(value).toLowerCase());
                case 'in':
                    return Array.isArray(value) ? value.includes(itemVal) : String(value).split(',').map((s: string) => s.trim()).includes(String(itemVal));
                default:
                    return itemVal == value;
            }
        });

        if (sortBy) {
            filtered.sort((a, b) => {
                const valA = extractJsonPath(a, sortBy).value;
                const valB = extractJsonPath(b, sortBy).value;
                if (typeof valA === 'number' && typeof valB === 'number') {
                    return sortOrder === 'desc' ? valB - valA : valA - valB;
                }
                return sortOrder === 'desc'
                    ? String(valB).localeCompare(String(valA))
                    : String(valA).localeCompare(String(valB));
            });
        }

        const results = typeof limit === 'number' && limit > 0 ? filtered.slice(0, limit) : filtered;
        return {
            matchedCount: filtered.length,
            totalCount: array.length,
            results,
            data: results
        };
    }
};
