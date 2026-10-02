/**
 * Resilient Zero-Drift AI JSON Repair Engine.
 * Transforms malformed, fenced, commented, unquoted, single-quoted, or truncated LLM outputs
 * into strictly valid JSON without any external runtime dependencies.
 */
export function repairJson(raw: string): string {
    if (!raw || typeof raw !== 'string') return '{}';

    // 1. Strip reasoning tags (DeepSeek R1, Llama 3.3, Qwen)
    let text = raw
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '')
        .replace(/<thought>[\s\S]*?<\/thought>/gi, '')
        .replace(/\[THOUGHT\][\s\S]*?\[\/THOUGHT\]/gi, '')
        .replace(/```(?:tool_call)[\s\S]*?```/gi, '');

    // Handle unclosed <think> tag if model was truncated mid-reasoning
    const thinkIdx = text.toLowerCase().indexOf('<think>');
    if (thinkIdx !== -1) {
        const jsonStart = text.slice(thinkIdx).search(/[{\[]/);
        if (jsonStart !== -1) {
            text = text.substring(0, thinkIdx) + text.substring(thinkIdx + jsonStart);
        } else {
            text = text.substring(0, thinkIdx);
        }
    }
    text = text.trim();

    // 2. Strip markdown fences
    text = text.replace(/^```(?:json|javascript|js)?\s*/i, '');
    text = text.replace(/\s*```$/i, '');

    // 3. Locate root JSON container start ({ or [)
    const firstObj = text.indexOf('{');
    const firstArr = text.indexOf('[');
    let startIdx = -1;

    if (firstObj !== -1 && (firstArr === -1 || firstObj < firstArr)) {
        startIdx = firstObj;
    } else if (firstArr !== -1) {
        startIdx = firstArr;
    }

    if (startIdx !== -1) {
        text = text.substring(startIdx);
    } else {
        return '{}';
    }

    // 4. Tokenizer & State Machine to sanitize comments, quotes, unquoted keys, and auto-close
    let out = '';
    let inString = false;
    let stringQuote = '';
    let isEscaped = false;
    const stack: string[] = [];

    let i = 0;
    while (i < text.length) {
        const char = text[i];
        const nextChar = text[i + 1] || '';

        if (inString) {
            if (isEscaped) {
                out += char;
                isEscaped = false;
            } else if (char === '\\') {
                out += char;
                isEscaped = true;
            } else if (char === stringQuote) {
                // End of string
                out += '"'; // Normalize to standard double quote
                inString = false;
                stringQuote = '';
            } else if (char === '\n') {
                out += '\\n';
            } else if (char === '\r') {
                // skip carriage return
            } else if (char === '\t') {
                out += '\\t';
            } else {
                out += char;
            }
            i++;
            continue;
        }

        // Outside string literal:
        // Handle single-line and multi-line comments
        if (char === '/' && nextChar === '/') {
            i += 2;
            while (i < text.length && text[i] !== '\n') i++;
            continue;
        }
        if (char === '/' && nextChar === '*') {
            i += 2;
            while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
            i += 2;
            continue;
        }

        // Handle string start (supports single or double quotes)
        if (char === '"' || char === "'") {
            inString = true;
            stringQuote = char;
            out += '"';
            i++;
            continue;
        }

        // Handle opening delimiters
        if (char === '{') {
            stack.push('}');
            out += char;
            i++;
            continue;
        }
        if (char === '[') {
            stack.push(']');
            out += char;
            i++;
            continue;
        }

        // Handle closing delimiters
        if (char === '}') {
            if (stack.length > 0 && stack[stack.length - 1] === '}') {
                stack.pop();
            }
            out += char;
            i++;
            if (stack.length === 0) {
                // Root container closed, stop appending trailing conversational prose
                break;
            }
            continue;
        }
        if (char === ']') {
            if (stack.length > 0 && stack[stack.length - 1] === ']') {
                stack.pop();
            }
            out += char;
            i++;
            if (stack.length === 0) {
                // Root array closed, stop appending trailing conversational prose
                break;
            }
            continue;
        }

        // Handle unquoted object keys: [a-zA-Z_$][a-zA-Z0-9_$-]* followed by :
        const identifierMatch = text.substring(i).match(/^([a-zA-Z_$][a-zA-Z0-9_$-]*)\s*:/);
        if (identifierMatch) {
            const key = identifierMatch[1];
            out += `"${key}":`;
            i += identifierMatch[0].length;
            continue;
        }

        // Handle Python / JS constants outside strings
        const literalMatch = text.substring(i).match(/^(True|False|None|undefined)\b/);
        if (literalMatch) {
            const lit = literalMatch[1];
            if (lit === 'True') out += 'true';
            else if (lit === 'False') out += 'false';
            else if (lit === 'None' || lit === 'undefined') out += 'null';
            i += lit.length;
            continue;
        }

        out += char;
        i++;
    }

    // 5. Clean up EOF state & auto-close truncations
    let repaired = out.trim();

    // If still in unclosed string at EOF, close quote
    if (inString) {
        repaired += '"';
    }

    // If inside an object and ends with dangling key without value, strip dangling key
    if (stack.length > 0 && stack[stack.length - 1] === '}') {
        repaired = repaired.replace(/([,{])\s*"[^"]*"\s*$/, '$1');
    }

    // Remove trailing commas outside strings
    repaired = repaired.replace(/,\s*([}\]])/g, '$1');
    repaired = repaired.replace(/,\s*$/g, '');

    // If ends with a dangling colon e.g. "key": -> append null
    if (/:\s*$/.test(repaired)) {
        repaired += ' null';
    }

    // Auto-close any remaining unclosed braces/brackets in reverse stack order
    while (stack.length > 0) {
        const closing = stack.pop()!;
        repaired = repaired.replace(/,\s*$/, '');
        repaired += closing;
    }

    return repaired;
}

/**
 * Fuzzy extractor for unstructured model outputs when all JSON attempts fail.
 */
export function extractFuzzyFields(text: string): Record<string, any> | null {
    if (!text || typeof text !== 'string') return null;

    const result: Record<string, any> = {};

    // Match Summary
    const summaryMatch = text.match(/(?:summary|executive\s*summary)[:\s-]+([^\n]+)/i);
    if (summaryMatch) {
        result.summary = summaryMatch[1].trim();
    }

    // Match Insights / Findings (bulleted lines)
    const insightsMatch = text.match(/(?:insights|findings|key\s*points)[:\s-]+([\s\S]*?)(?=(?:anomalies|recommendations|summary|$))/i);
    if (insightsMatch) {
        const lines = insightsMatch[1]
            .split('\n')
            .map(l => l.replace(/^[-*•\d.]+\s*/, '').trim())
            .filter(l => l.length > 0);
        if (lines.length > 0) {
            result.insights = lines;
        }
    }

    // Match Anomalies / Warnings
    const anomaliesMatch = text.match(/(?:anomalies|issues|errors|warnings)[:\s-]+([\s\S]*?)(?=(?:recommendations|summary|$))/i);
    if (anomaliesMatch) {
        const lines = anomaliesMatch[1]
            .split('\n')
            .map(l => l.replace(/^[-*•\d.]+\s*/, '').trim())
            .filter(l => l.length > 0 && !/^none$/i.test(l));
        result.anomalies = lines;
    } else {
        result.anomalies = [];
    }

    return Object.keys(result).length > 0 ? result : null;
}
