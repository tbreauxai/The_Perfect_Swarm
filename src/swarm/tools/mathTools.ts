import type { SwarmTool } from './types.ts';

/**
 * Evaluates a mathematical expression safely without eval or Function.
 */
export function safeEvaluateMath(expr: string): number {
    const sanitized = expr.replace(/\s+/g, '');
    let pos = 0;

    function parseExpression(): number {
        let val = parseTerm();
        while (pos < sanitized.length) {
            const op = sanitized[pos];
            if (op === '+') {
                pos++;
                val += parseTerm();
            } else if (op === '-') {
                pos++;
                val -= parseTerm();
            } else {
                break;
            }
        }
        return val;
    }

    function parseTerm(): number {
        let val = parseFactor();
        while (pos < sanitized.length) {
            const op = sanitized[pos];
            if (op === '*') {
                pos++;
                val *= parseFactor();
            } else if (op === '/') {
                pos++;
                const divisor = parseFactor();
                if (divisor === 0) throw new Error('Division by zero');
                val /= divisor;
            } else if (op === '%') {
                pos++;
                const divisor = parseFactor();
                if (divisor === 0) throw new Error('Modulo by zero');
                val %= divisor;
            } else {
                break;
            }
        }
        return val;
    }

    function parseFactor(): number {
        if (pos >= sanitized.length) throw new Error('Unexpected end of expression');

        if (sanitized[pos] === '+') {
            pos++;
            return parseFactor();
        }
        if (sanitized[pos] === '-') {
            pos++;
            return -parseFactor();
        }

        if (sanitized[pos] === '(') {
            pos++;
            const val = parseExpression();
            if (sanitized[pos] !== ')') throw new Error("Missing closing parenthesis ')'");
            pos++;
            return val;
        }

        const start = pos;
        while (pos < sanitized.length && /[0-9.]/.test(sanitized[pos])) {
            pos++;
        }
        if (start === pos) {
            throw new Error(`Unexpected character '${sanitized[pos]}' at index ${pos}`);
        }

        const num = parseFloat(sanitized.substring(start, pos));
        if (isNaN(num)) throw new Error(`Invalid number '${sanitized.substring(start, pos)}'`);
        return num;
    }

    const result = parseExpression();
    if (pos < sanitized.length) {
        throw new Error(`Unexpected character '${sanitized[pos]}' remaining at index ${pos}`);
    }
    return result;
}

/**
 * Built-in safe calculator tool.
 */
export const calculatorTool: SwarmTool<{ expression: string }, { expression: string; result: number }> = {
    name: 'calculator',
    description: 'Safely evaluates arithmetic expressions (+, -, *, /, %, parenthesis) without eval.',
    parameters: {
        expression: {
            type: 'string',
            description: 'The mathematical expression to evaluate (e.g. "((15 * 4) + 120) / 1.5")',
            required: true
        }
    },
    execute({ expression }) {
        if (!expression || typeof expression !== 'string') {
            throw new Error('Calculator requires a string expression parameter.');
        }
        const result = safeEvaluateMath(expression);
        return { expression, result };
    }
};
