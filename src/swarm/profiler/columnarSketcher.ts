/**
 * @file columnarSketcher.ts
 * @description Zero-LLM Single-Pass Columnar Sketcher, Anomaly Row Extractor, and Provider-Aware Adaptive Chunk Sharder.
 * Compresses large CSV, pipe-table, JSON array, and log datasets into exact statistical distribution digests
 * plus top z-score outlier rows, and sizes shards to each specialist seat's provider input token ceiling.
 */

import { PROVIDER_LIMITS } from '../providers/limiter.ts';

export interface ColumnSketch {
    name: string;
    type: 'numeric' | 'categorical' | 'temporal';
    count: number;
    missingCount: number;
    mean?: number;
    stdDev?: number;
    min?: number;
    p25?: number;
    median?: number;
    p75?: number;
    max?: number;
    iqr?: number;
    skewness?: number;
    trendSlope?: number;
    topCategories?: Array<{ value: string; count: number; pct: number }>;
}

export interface ColumnCorrelation {
    colA: string;
    colB: string;
    pearsonR: number;
    direction: 'positive' | 'negative';
}

export interface AnomalyRowExtract {
    rowId: string;
    rowIndex: number;
    maxAbsZScore: number;
    triggerColumns: string[];
    rawText: string;
}

export interface DatasetSketch {
    format: 'CSV' | 'PipeTable' | 'JSON' | 'Logs';
    totalRows: number;
    columnCount: number;
    columns: ColumnSketch[];
    correlations: ColumnCorrelation[];
    anomalyRows: AnomalyRowExtract[];
    stratifiedSample: Array<{ rowId: string; position: 'head' | 'median' | 'tail'; rawText: string }>;
    originalTokens: number;
    sketchTokens: number;
    tokensSaved: number;
    compressionRatio: number;
    digestText: string;
}

export interface SeatShardAllocation {
    seatId: string;
    agentRole: string;
    provider: string;
    providerMaxInputTokens: number;
    effectiveTokenBudget: number;
    shardMode: 'sketch_plus_anomalies' | 'adaptive_partition' | 'full_context';
    assignedShardIndices: number[];
    estimatedShardTokens: number;
    truncationAvoidedTokens: number;
}

export interface AdaptiveShardPlan {
    shards: string[];
    seatAllocations: SeatShardAllocation[];
    sketchUsed: boolean;
    totalOriginalTokens: number;
    totalShardedTokens: number;
    tokensSavedBySketching: number;
}

function round4(n: number): number {
    return Number.isFinite(n) ? Number(n.toFixed(4)) : 0;
}

function quantileSorted(sorted: number[], q: number): number {
    if (sorted.length === 0) return 0;
    if (sorted.length === 1) return sorted[0];
    const pos = (sorted.length - 1) * q;
    const base = Math.floor(pos);
    const rest = pos - base;
    if (sorted[base + 1] !== undefined) {
        return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
    }
    return sorted[base];
}

function isTemporalString(val: string): boolean {
    if (!val || val.length < 6 || val.length > 35) return false;
    return /^\d{4}-\d{2}-\d{2}/.test(val) || /^\d{1,2}\/\d{1,2}\/\d{2,4}/.test(val);
}

function parseTabularInput(rawInput: string): {
    format: 'CSV' | 'PipeTable' | 'JSON' | 'Logs';
    headers: string[];
    rows: Array<{ rowId: string; cells: string[]; rawLine: string }>;
} {
    const trimmed = (rawInput || '').trim();
    if (!trimmed) {
        return { format: 'Logs', headers: ['line'], rows: [] };
    }

    // 1. JSON Array or Object with data array
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
        try {
            const parsed = JSON.parse(trimmed);
            const arr = Array.isArray(parsed)
                ? parsed
                : Array.isArray(parsed?.data)
                ? parsed.data
                : Array.isArray(parsed?.rows)
                ? parsed.rows
                : Array.isArray(parsed?.records)
                ? parsed.records
                : null;

            if (arr && arr.length > 0 && typeof arr[0] === 'object' && arr[0] !== null) {
                const headerSet = new Set<string>();
                for (let i = 0; i < Math.min(arr.length, 50); i++) {
                    if (arr[i] && typeof arr[i] === 'object') {
                        Object.keys(arr[i]).forEach(k => headerSet.add(k));
                    }
                }
                const headers = Array.from(headerSet);
                const rows = arr.map((item: any, idx: number) => {
                    const explicitId = item?.id && /^R\d+$/.test(String(item.id)) ? String(item.id) : `R${idx + 1}`;
                    const cells = headers.map(h => {
                        const v = item?.[h];
                        return v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
                    });
                    return {
                        rowId: explicitId,
                        cells,
                        rawLine: `${explicitId} | ${headers.map((h, cIdx) => `${h}=${cells[cIdx]}`).join(' | ')}`
                    };
                });
                return { format: 'JSON', headers, rows };
            }
        } catch {
            // Fall through to line-based parsing
        }
    }

    const lines = trimmed.split(/\r?\n/).filter(l => l.trim().length > 0);
    if (lines.length === 0) {
        return { format: 'Logs', headers: ['line'], rows: [] };
    }

    // 2. Pipe-delimited table
    const firstPipeCount = (lines[0].match(/\|/g) || []).length;
    if (firstPipeCount >= 2 && lines.length >= 2) {
        const splitPipe = (line: string) =>
            line.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
        const firstCells = splitPipe(lines[0]);
        const hasHeader = firstCells.some(c => /[a-zA-Z]/.test(c)) && !/^R\d+$/.test(firstCells[0]);
        const headers = hasHeader ? firstCells : firstCells.map((_, i) => `col_${i + 1}`);
        const startIdx = hasHeader ? 1 : 0;
        const rows: Array<{ rowId: string; cells: string[]; rawLine: string }> = [];

        for (let i = startIdx; i < lines.length; i++) {
            const line = lines[i];
            if (/^[\s|\-:]+$/.test(line)) continue; // markdown separator row
            const cells = splitPipe(line);
            const rowId = /^R\d+$/.test(cells[0]) ? cells[0] : `R${rows.length + 1}`;
            rows.push({
                rowId,
                cells,
                rawLine: line.startsWith(rowId) ? line : `${rowId} | ${line}`
            });
        }
        return { format: 'PipeTable', headers, rows };
    }

    // 3. CSV table
    const firstCommaCount = (lines[0].match(/,/g) || []).length;
    if (firstCommaCount >= 1 && lines.length >= 2) {
        const splitCsv = (line: string): string[] => {
            const out: string[] = [];
            let cur = '';
            let inQuotes = false;
            for (let i = 0; i < line.length; i++) {
                const ch = line[i];
                if (ch === '"') {
                    inQuotes = !inQuotes;
                } else if (ch === ',' && !inQuotes) {
                    out.push(cur.trim());
                    cur = '';
                } else {
                    cur += ch;
                }
            }
            out.push(cur.trim());
            return out;
        };

        const firstCells = splitCsv(lines[0]);
        const secondCells = splitCsv(lines[1]);
        if (firstCells.length >= 2 && Math.abs(firstCells.length - secondCells.length) <= 1) {
            const headers = firstCells.map((h, i) => h || `col_${i + 1}`);
            const rows = lines.slice(1).map((line, idx) => {
                const cells = splitCsv(line);
                const rowId = /^R\d+$/.test(cells[0]) ? cells[0] : `R${idx + 1}`;
                return {
                    rowId,
                    cells,
                    rawLine: `${rowId}: ${line}`
                };
            });
            return { format: 'CSV', headers, rows };
        }
    }

    // 4. Fallback: Unstructured / semi-structured logs
    const rows = lines.map((line, idx) => ({
        rowId: `R${idx + 1}`,
        cells: [line],
        rawLine: `R${idx + 1}: ${line}`
    }));
    return { format: 'Logs', headers: ['log_entry'], rows };
}

/**
 * Computes a deterministic single-pass columnar sketch, correlation matrix, and top-z-score anomaly extract.
 */
export function sketchDataset(
    rawInput: string,
    options: { maxAnomalyRows?: number; maxSampleRows?: number; zScoreThreshold?: number } = {}
): DatasetSketch {
    const maxAnomalyRows = options.maxAnomalyRows ?? 12;
    const maxSampleRows = options.maxSampleRows ?? 6;
    const zScoreThreshold = options.zScoreThreshold ?? 2.0;

    const originalTokens = Math.max(1, Math.ceil((rawInput || '').length / 4));
    const { format, headers, rows } = parseTabularInput(rawInput);
    const totalRows = rows.length;
    const columnCount = headers.length;

    const columns: ColumnSketch[] = [];
    const numericColumnValues: Map<number, Map<number, number>> = new Map();

    for (let c = 0; c < columnCount; c++) {
        const colName = headers[c] || `col_${c + 1}`;
        const numVals: number[] = [];
        const numByRow = new Map<number, number>();
        const catCounts = new Map<string, number>();
        let missingCount = 0;
        let temporalHits = 0;
        let nonEmptyCount = 0;

        for (let r = 0; r < totalRows; r++) {
            const rawVal = (rows[r].cells[c] ?? '').trim();
            if (!rawVal || rawVal === 'null' || rawVal === 'NA' || rawVal === 'N/A' || rawVal === 'undefined') {
                missingCount++;
                continue;
            }
            nonEmptyCount++;
            const cleanedNum = rawVal.replace(/[$%,]/g, '');
            const parsedNum = Number(cleanedNum);
            if (cleanedNum !== '' && !Number.isNaN(parsedNum) && Number.isFinite(parsedNum)) {
                numVals.push(parsedNum);
                numByRow.set(r, parsedNum);
            } else {
                if (isTemporalString(rawVal)) temporalHits++;
                catCounts.set(rawVal, (catCounts.get(rawVal) || 0) + 1);
            }
        }

        const isNumeric = nonEmptyCount > 0 && numVals.length / nonEmptyCount >= 0.65;
        const isTemporal = !isNumeric && nonEmptyCount > 0 && temporalHits / nonEmptyCount >= 0.6;

        if (isNumeric && numVals.length > 0) {
            numericColumnValues.set(c, numByRow);
            const sorted = [...numVals].sort((a, b) => a - b);
            const n = numVals.length;
            let sum = 0;
            for (let i = 0; i < n; i++) sum += numVals[i];
            const mean = sum / n;

            let m2 = 0;
            let m3 = 0;
            let sumXY = 0;
            const meanX = (n - 1) / 2;
            let sumXX = 0;

            for (let i = 0; i < n; i++) {
                const diff = numVals[i] - mean;
                m2 += diff * diff;
                m3 += diff * diff * diff;
                const dx = i - meanX;
                sumXY += dx * diff;
                sumXX += dx * dx;
            }

            const variance = n > 1 ? m2 / n : 0;
            const stdDev = Math.sqrt(variance);
            const skewness = n > 2 && stdDev > 1e-9 ? (m3 / n) / Math.pow(stdDev, 3) : 0;
            const trendSlope = sumXX > 0 ? sumXY / sumXX : 0;
            const p25 = quantileSorted(sorted, 0.25);
            const median = quantileSorted(sorted, 0.5);
            const p75 = quantileSorted(sorted, 0.75);

            columns.push({
                name: colName,
                type: 'numeric',
                count: nonEmptyCount,
                missingCount,
                mean: round4(mean),
                stdDev: round4(stdDev),
                min: round4(sorted[0]),
                p25: round4(p25),
                median: round4(median),
                p75: round4(p75),
                max: round4(sorted[sorted.length - 1]),
                iqr: round4(p75 - p25),
                skewness: round4(skewness),
                trendSlope: round4(trendSlope)
            });
        } else {
            const topCategories = Array.from(catCounts.entries())
                .sort((a, b) => b[1] - a[1])
                .slice(0, 5)
                .map(([value, count]) => ({
                    value: value.slice(0, 48),
                    count,
                    pct: nonEmptyCount > 0 ? Math.round((count / nonEmptyCount) * 1000) / 10 : 0
                }));

            columns.push({
                name: colName,
                type: isTemporal ? 'temporal' : 'categorical',
                count: nonEmptyCount,
                missingCount,
                topCategories
            });
        }
    }

    // 2. Pairwise Pearson correlations across numeric columns (up to first 10 numeric cols)
    const numericColIndices = Array.from(numericColumnValues.keys()).slice(0, 10);
    const correlations: ColumnCorrelation[] = [];
    for (let i = 0; i < numericColIndices.length; i++) {
        for (let j = i + 1; j < numericColIndices.length; j++) {
            const colAIdx = numericColIndices[i];
            const colBIdx = numericColIndices[j];
            const mapA = numericColumnValues.get(colAIdx)!;
            const mapB = numericColumnValues.get(colBIdx)!;
            const colA = columns[colAIdx];
            const colB = columns[colBIdx];
            if (!colA.stdDev || !colB.stdDev || colA.stdDev < 1e-9 || colB.stdDev < 1e-9) continue;

            let cov = 0;
            let overlap = 0;
            for (const [rIdx, valA] of mapA.entries()) {
                const valB = mapB.get(rIdx);
                if (valB !== undefined) {
                    cov += (valA - (colA.mean || 0)) * (valB - (colB.mean || 0));
                    overlap++;
                }
            }
            if (overlap >= 5) {
                const r = cov / (overlap * colA.stdDev * colB.stdDev);
                if (Math.abs(r) >= 0.35 && Number.isFinite(r)) {
                    const clampedR = Math.max(-1, Math.min(1, r));
                    correlations.push({
                        colA: colA.name,
                        colB: colB.name,
                        pearsonR: round4(clampedR),
                        direction: clampedR >= 0 ? 'positive' : 'negative'
                    });
                }
            }
        }
    }
    correlations.sort((a, b) => Math.abs(b.pearsonR) - Math.abs(a.pearsonR));

    // 3. Extract Top Z-Score / IQR Anomaly Rows
    const anomalyCandidates: AnomalyRowExtract[] = [];
    if (numericColIndices.length > 0) {
        for (let r = 0; r < totalRows; r++) {
            let maxZ = 0;
            const triggers: string[] = [];
            for (const cIdx of numericColIndices) {
                const col = columns[cIdx];
                const val = numericColumnValues.get(cIdx)?.get(r);
                if (val === undefined || !col.stdDev || col.stdDev < 1e-9) continue;
                const z = Math.abs((val - (col.mean || 0)) / col.stdDev);
                if (z >= zScoreThreshold) {
                    if (z > maxZ) maxZ = z;
                    triggers.push(`${col.name}=${val} (z=${z.toFixed(2)})`);
                }
            }
            if (triggers.length > 0) {
                anomalyCandidates.push({
                    rowId: rows[r].rowId,
                    rowIndex: r + 1,
                    maxAbsZScore: round4(maxZ),
                    triggerColumns: triggers.slice(0, 4),
                    rawText: rows[r].rawLine.slice(0, 260)
                });
            }
        }
    } else if (format === 'Logs') {
        const errorPattern = /error|exception|fatal|critical|timeout|fail|anomaly|spike|warn|429|503/i;
        for (let r = 0; r < totalRows; r++) {
            if (errorPattern.test(rows[r].rawLine)) {
                anomalyCandidates.push({
                    rowId: rows[r].rowId,
                    rowIndex: r + 1,
                    maxAbsZScore: 3.0,
                    triggerColumns: ['log_severity_match'],
                    rawText: rows[r].rawLine.slice(0, 260)
                });
            }
        }
    }

    anomalyCandidates.sort((a, b) => b.maxAbsZScore - a.maxAbsZScore);
    const anomalyRows = anomalyCandidates.slice(0, maxAnomalyRows);

    // 4. Stratified Sample (Head, Median, Tail)
    const stratifiedSample: Array<{ rowId: string; position: 'head' | 'median' | 'tail'; rawText: string }> = [];
    if (totalRows > 0) {
        const headCount = Math.min(2, totalRows);
        for (let i = 0; i < headCount; i++) {
            stratifiedSample.push({
                rowId: rows[i].rowId,
                position: 'head',
                rawText: rows[i].rawLine.slice(0, 220)
            });
        }
        if (totalRows >= 6) {
            const mid = Math.floor(totalRows / 2);
            for (let i = mid; i < Math.min(mid + Math.max(1, maxSampleRows - 4), totalRows - 2); i++) {
                stratifiedSample.push({
                    rowId: rows[i].rowId,
                    position: 'median',
                    rawText: rows[i].rawLine.slice(0, 220)
                });
            }
        }
        if (totalRows > 2) {
            const tailStart = Math.max(headCount, totalRows - 2);
            for (let i = tailStart; i < totalRows; i++) {
                stratifiedSample.push({
                    rowId: rows[i].rowId,
                    position: 'tail',
                    rawText: rows[i].rawLine.slice(0, 220)
                });
            }
        }
    }

    // 5. Render Compact Statistical Sketch & Anomaly Digest Text
    const linesOut: string[] = [
        `[Columnar Dataset Sketch (${format} | ${totalRows.toLocaleString()} rows × ${columnCount} cols)]`
    ];

    const colSummaries = columns.slice(0, 16).map(col => {
        if (col.type === 'numeric') {
            return `• ${col.name} [numeric, n=${col.count}]: mean=${col.mean}, sd=${col.stdDev}, min=${col.min}, p25=${col.p25}, median=${col.median}, p75=${col.p75}, max=${col.max}, slope=${col.trendSlope}`;
        }
        const cats = (col.topCategories || []).map(t => `${t.value} (${t.pct}%)`).join(', ');
        return `• ${col.name} [${col.type}, n=${col.count}]: top=[${cats}]`;
    });
    if (colSummaries.length > 0) {
        linesOut.push('Column Distributions:\n' + colSummaries.join('\n'));
    }

    if (correlations.length > 0) {
        linesOut.push(
            'Top Column Correlations:\n' +
            correlations.slice(0, 6).map(c => `• ${c.colA} ↔ ${c.colB}: r=${c.pearsonR} (${c.direction})`).join('\n')
        );
    }

    if (anomalyRows.length > 0) {
        linesOut.push(
            `Top Statistical Outlier Rows (${anomalyRows.length} of ${anomalyCandidates.length} flagged, |z| >= ${zScoreThreshold}):\n` +
            anomalyRows.map(a => `• ${a.rowId} [max |z|=${a.maxAbsZScore} on ${a.triggerColumns.join(', ')}]: ${a.rawText}`).join('\n')
        );
    }

    if (stratifiedSample.length > 0) {
        linesOut.push(
            'Stratified Boundary Rows (Head / Median / Tail):\n' +
            stratifiedSample.map(s => `• [${s.position.toUpperCase()}] ${s.rawText}`).join('\n')
        );
    }

    const digestText = linesOut.join('\n\n');
    const sketchTokens = Math.max(1, Math.ceil(digestText.length / 4));
    const tokensSaved = Math.max(0, originalTokens - sketchTokens);
    const compressionRatio = originalTokens > 0 ? Number((tokensSaved / originalTokens).toFixed(4)) : 0;

    return {
        format,
        totalRows,
        columnCount,
        columns,
        correlations: correlations.slice(0, 8),
        anomalyRows,
        stratifiedSample,
        originalTokens,
        sketchTokens,
        tokensSaved,
        compressionRatio,
        digestText
    };
}

/**
 * Builds a Provider-Aware Adaptive Shard Plan that sizes chunks to match each specialist seat's
 * real input token ceiling (avoiding mid-chunk truncation on tight free-tier providers like Groq/Mistral).
 */
export function planAdaptiveProviderShards(params: {
    rawInput: string;
    chunks: string[];
    sketch?: DatasetSketch;
    analysts: Array<{ id?: string; role: string; provider: string }>;
    enablePreAggregationSketch?: boolean;
    enableProviderSharding?: boolean;
    overheadTokens?: number;
}): AdaptiveShardPlan {
    const {
        rawInput,
        chunks,
        sketch,
        analysts,
        enablePreAggregationSketch = true,
        enableProviderSharding = true,
        overheadTokens = 350
    } = params;

    const totalOriginalTokens = Math.max(1, Math.ceil((rawInput || '').length / 4));
    const isMultiChunkOrLarge = chunks.length > 1 || totalOriginalTokens > 1400;

    if (!enableProviderSharding && !enablePreAggregationSketch) {
        return {
            shards: chunks,
            seatAllocations: analysts.map((a, idx) => ({
                seatId: a.id || a.role,
                agentRole: a.role,
                provider: a.provider,
                providerMaxInputTokens: PROVIDER_LIMITS[a.provider?.toLowerCase()]?.maxInputTokens || 8000,
                effectiveTokenBudget: PROVIDER_LIMITS[a.provider?.toLowerCase()]?.maxInputTokens || 8000,
                shardMode: 'full_context',
                assignedShardIndices: [idx % Math.max(1, chunks.length)],
                estimatedShardTokens: Math.ceil((chunks[0] || '').length / 4),
                truncationAvoidedTokens: 0
            })),
            sketchUsed: false,
            totalOriginalTokens,
            totalShardedTokens: totalOriginalTokens,
            tokensSavedBySketching: 0
        };
    }

    const activeSketch = (enablePreAggregationSketch && isMultiChunkOrLarge)
        ? (sketch || sketchDataset(rawInput))
        : undefined;

    // If dataset is large (e.g., > 2 chunks) and sketching achieved >= 45% compression with structured columns/anomalies,
    // prepend the global sketch digest as Shard 0 and build compact provider-safe shards.
    const sketchEffective = Boolean(
        activeSketch &&
        activeSketch.totalRows >= 15 &&
        activeSketch.compressionRatio >= 0.35
    );

    let effectiveShards = [...chunks];
    if (sketchEffective && activeSketch && chunks.length > 2) {
        // Combine global statistical sketch + top anomalies as primary high-signal shard,
        // plus representative head and tail data partitions so wave count stays rate-limit safe.
        const firstPartition = chunks[0];
        const lastPartition = chunks[chunks.length - 1];
        effectiveShards = [
            `${activeSketch.digestText}\n\n--- Primary Partition Sample ---\n${firstPartition.slice(0, 6000)}`,
            ...(chunks.length > 1 ? [`${activeSketch.digestText}\n\n--- Closing Partition Sample ---\n${lastPartition.slice(0, 6000)}`] : [])
        ];
    } else if (sketchEffective && activeSketch && chunks.length >= 1) {
        effectiveShards = chunks.map((c, idx) =>
            idx === 0 ? `${activeSketch.digestText}\n\n--- Raw Data Partition [1/${chunks.length}] ---\n${c}` : c
        );
    }

    const seatAllocations: SeatShardAllocation[] = analysts.map((analyst, idx) => {
        const prov = (analyst.provider || '').toLowerCase();
        const providerMaxInputTokens = PROVIDER_LIMITS[prov]?.maxInputTokens || 8000;
        const effectiveTokenBudget = Math.max(600, providerMaxInputTokens - overheadTokens);
        const primaryShardIdx = idx % Math.max(1, effectiveShards.length);
        const rawChunkTokens = Math.ceil((chunks[primaryShardIdx] || chunks[0] || '').length / 4);

        const isTightProvider = providerMaxInputTokens <= 2500;
        const shardMode: SeatShardAllocation['shardMode'] =
            sketchEffective && isTightProvider
                ? 'sketch_plus_anomalies'
                : enableProviderSharding && rawChunkTokens > effectiveTokenBudget
                ? 'adaptive_partition'
                : 'full_context';

        const estimatedShardTokens = Math.min(rawChunkTokens, effectiveTokenBudget);
        const truncationAvoidedTokens = Math.max(0, rawChunkTokens - estimatedShardTokens);

        return {
            seatId: analyst.id || analyst.role,
            agentRole: analyst.role,
            provider: analyst.provider,
            providerMaxInputTokens,
            effectiveTokenBudget,
            shardMode,
            assignedShardIndices: [primaryShardIdx],
            estimatedShardTokens,
            truncationAvoidedTokens
        };
    });

    const totalShardedTokens = effectiveShards.reduce((sum, s) => sum + Math.ceil(s.length / 4), 0);
    const tokensSavedBySketching = Math.max(0, totalOriginalTokens - totalShardedTokens);

    return {
        shards: effectiveShards,
        seatAllocations,
        sketchUsed: sketchEffective,
        totalOriginalTokens,
        totalShardedTokens,
        tokensSavedBySketching
    };
}
