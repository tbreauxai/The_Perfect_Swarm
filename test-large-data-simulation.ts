import {
    executeSwarmWorkflow,
    ProviderRegistry,
    profileData,
    createTokenChunks,
    DEFAULT_MAX_CHARS,
    DEFAULT_MAX_CHUNKS,
    SwarmContext,
    type SwarmStagePayload
} from './src/swarm/index.ts';

async function runLargeDataStressSimulation() {
    console.log('================================================================');
    console.log('  50,000-ROW LARGE DATA SWARM RESILIENCE & STRESS SIMULATION');
    console.log('================================================================\n');

    const startTime = Date.now();

    // -------------------------------------------------------------
    // STEP 1: High-Volume Payload Generation (50,000 Rows CSV)
    // -------------------------------------------------------------
    console.log('>>> [Step 1] Synthesizing 50,000-row CSV telemetry payload...');
    const csvHeader = 'timestamp,device_id,cluster_zone,cpu_utilization,memory_usage_mb,network_in_kbps,network_out_kbps,status_code,error_message';
    const rows: string[] = [csvHeader];

    const zones = ['us-east-1a', 'us-east-1b', 'us-west-2a', 'eu-central-1a', 'ap-southeast-1a'];
    const baseTime = Date.parse('2026-10-23T00:00:00Z');

    for (let i = 0; i < 50000; i++) {
        const timestamp = new Date(baseTime + i * 1000).toISOString();
        const deviceId = `node-${String((i % 250) + 1).padStart(4, '0')}`;
        const zone = zones[i % zones.length];
        const cpu = (20 + (i % 75) + Math.sin(i) * 5).toFixed(2);
        const mem = 1024 + (i % 8192);
        const netIn = 500 + (i % 2000);
        const netOut = 450 + (i % 1800);
        const status = i % 1000 === 0 ? 500 : (i % 250 === 0 ? 429 : 200);
        const error = status === 500 ? 'INTERNAL_SERVER_ERROR' : (status === 429 ? 'RATE_LIMIT_EXCEEDED' : '');

        rows.push(`${timestamp},${deviceId},${zone},${cpu},${mem},${netIn},${netOut},${status},${error}`);
    }

    const payload = rows.join('\n');
    const payloadBytes = Buffer.byteLength(payload, 'utf-8');
    const payloadMB = (payloadBytes / (1024 * 1024)).toFixed(2);

    console.log(`    Payload generated: ${rows.length - 1} data rows + 1 header (${payloadMB} MB / ${payload.length} chars)`);

    // -------------------------------------------------------------
    // STEP 2: Profiling & Zero-Loss Chunking Verification
    // -------------------------------------------------------------
    console.log('\n>>> [Step 2] Verifying Payload Profiling & Zero-Loss Chunking...');
    const { rawInput, profile } = profileData(payload);

    if (rawInput.includes('...[TRUNCATED FOR MEMORY SAFETY]...')) {
        throw new Error(`FAIL: Payload was truncated by profileData! Max chars limit (${DEFAULT_MAX_CHARS}) exceeded.`);
    }

    if (profile.rowCount !== 50001) {
        throw new Error(`FAIL: Expected 50001 rows in profile, got ${profile.rowCount}`);
    }

    if (profile.format !== 'Text/CSV') {
        throw new Error(`FAIL: Expected format Text/CSV, got ${profile.format}`);
    }

    console.log(`    Profile verified: format=${profile.format}, rows=${profile.rowCount}, tokens=~${profile.estimatedTokens}`);

    const { chunks } = createTokenChunks(rawInput);
    console.log(`    Token chunking produced ${chunks.length} chunks (DEFAULT_MAX_CHUNKS=${DEFAULT_MAX_CHUNKS})`);

    if (chunks.length < 50) {
        throw new Error(`FAIL: Expected >= 50 chunks for 50k rows, got ${chunks.length}`);
    }

    // Verify CSV Header Propagation across chunks 2+
    for (let c = 1; c < chunks.length; c++) {
        const firstChunkLine = chunks[c].split('\n')[0].trim();
        if (firstChunkLine !== csvHeader) {
            throw new Error(`FAIL: Chunk #${c + 1} missing propagated CSV header! First line: "${firstChunkLine}"`);
        }
    }
    console.log(`    Verified CSV header correctly propagated across all ${chunks.length} chunks.`);

    // -------------------------------------------------------------
    // STEP 3: Setup Mock Resilient Providers
    // -------------------------------------------------------------
    console.log('\n>>> [Step 3] Registering Mock Providers with Rate-Limit & Token Protections...');

    let inFlightAnalystCalls = 0;
    let peakConcurrency = 0;
    let totalAnalystCalls = 0;
    let managerCalls = 0;
    let managerPromptTokensReceived = 0;

    const seenChunkIndices = new Set<number>();
    const analystRolesSeen = new Set<string>();

    ProviderRegistry.register({
        providerName: 'sim-stress-analyst',
        async call(opts) {
            totalAnalystCalls++;
            inFlightAnalystCalls++;
            if (inFlightAnalystCalls > peakConcurrency) {
                peakConcurrency = inFlightAnalystCalls;
            }

            if (opts.role) {
                analystRolesSeen.add(opts.role);
            }

            // Extract chunk index from prompt
            const match = opts.prompt?.match(/Data Chunk \[(\d+)\/(\d+)\]/i);
            let chunkIdx = 0;
            let totalChunks = 0;
            if (match) {
                chunkIdx = parseInt(match[1], 10);
                totalChunks = parseInt(match[2], 10);
                seenChunkIndices.add(chunkIdx);

                // Verify CSV header is present in prompt for chunkIdx > 1
                if (chunkIdx > 1 && !opts.prompt.includes(csvHeader)) {
                    throw new Error(`FAIL: Analyst received chunk [${chunkIdx}/${totalChunks}] without propagated CSV header`);
                }
            }

            // Simulate brief async compute
            await new Promise(r => setTimeout(r, 2));

            inFlightAnalystCalls--;

            return JSON.stringify({
                source: 'sim-stress-analyst',
                chunk: chunkIdx,
                insights: [
                    `Analyzed chunk ${chunkIdx}/${totalChunks} for role ${opts.role}`,
                    `Telemetry distribution nominal across zones`
                ],
                anomalies: chunkIdx % 25 === 0 ? [`Transient spike detected in chunk ${chunkIdx}`] : [],
                summary: `Evaluated chunk ${chunkIdx} telemetry with zero dropped rows.`
            });
        }
    });

    ProviderRegistry.register({
        providerName: 'groq',
        async call(opts) {
            managerCalls++;
            const promptChars = opts.prompt?.length || 0;
            managerPromptTokensReceived = Math.ceil(promptChars / 4);

            // Assert that the manager prompt was safely budgeted (Groq context ceiling is 6,000 tokens)
            // Allow a small safety margin: <= 6500 tokens
            if (managerPromptTokensReceived > 6500) {
                throw new Error(`FAIL: Manager synthesis prompt exceeded Groq token ceiling! Received ~${managerPromptTokensReceived} tokens.`);
            }

            return JSON.stringify({
                ui_title: '50,000-Row Infrastructure Telemetry Stress Analysis',
                summary: `Successfully processed full 50,000-row telemetry payload across ${seenChunkIndices.size} chunks without data loss. Concurrency bounded cleanly.`,
                components: [
                    {
                        id: 'ingestion-summary',
                        type: 'MetricCard',
                        props: { title: 'Rows Processed', value: 50000, status: 'VERIFIED' }
                    },
                    {
                        id: 'chunk-distribution',
                        type: 'MetricCard',
                        props: { title: 'Chunks Evaluated', value: seenChunkIndices.size, status: 'ZERO_LOSS' }
                    },
                    {
                        id: 'manager-prompt-fit',
                        type: 'MetricCard',
                        props: { title: 'Manager Prompt Tokens', value: managerPromptTokensReceived, ceiling: 6000 }
                    }
                ]
            });
        }
    });

    // -------------------------------------------------------------
    // STEP 4: End-to-End Swarm Workflow Execution
    // -------------------------------------------------------------
    console.log('\n>>> [Step 4] Executing Swarm Engine with Hierarchical Wave Scheduling...');
    const stageEvents: SwarmStagePayload[] = [];
    const waveProgressEvents: SwarmStagePayload[] = [];

    const result = await executeSwarmWorkflow({
        task: 'Audit and analyze 50,000-row infrastructure telemetry dataset for cluster anomalies and memory leaks',
        data: payload,
        forceFullSwarm: true,
        bypassCache: true,
        onStage: (stagePayload) => {
            stageEvents.push(stagePayload);
            if (stagePayload.stage === 'wave_progress') {
                waveProgressEvents.push(stagePayload);
            }
        },
        settings: {
            speculativeParallel: false,
            waveBatchSize: 8,
            analystStaggerMs: 0,
            providerPacingMs: {
                'sim-stress-analyst': 0,
                'groq': 0
            },
            agents: [
                {
                    id: 'manager',
                    role: 'Manager Node',
                    provider: 'groq',
                    model: 'llama-3.3-70b-versatile',
                    apiKey: 'gsk-mock-key'
                },
                {
                    id: 'analyst-reliability',
                    role: 'Cluster Reliability Specialist',
                    provider: 'sim-stress-analyst',
                    model: 'mock-analyst-v1',
                    apiKey: 'k-mock'
                },
                {
                    id: 'analyst-metrics',
                    role: 'Telemetry & Metric Specialist',
                    provider: 'sim-stress-analyst',
                    model: 'mock-analyst-v1',
                    apiKey: 'k-mock'
                }
            ]
        }
    });

    const elapsedSeconds = ((Date.now() - startTime) / 1000).toFixed(2);

    // -------------------------------------------------------------
    // STEP 5: Verification & Invariant Assertions
    // -------------------------------------------------------------
    console.log('\n>>> [Step 5] Auditing Swarm Invariants & Results...');

    console.log(`    Total Elapsed Time: ${elapsedSeconds}s`);
    console.log(`    Peak Specialist Concurrency: ${peakConcurrency} (waveBatchSize limit: 8)`);
    console.log(`    Total Specialist Invocations: ${totalAnalystCalls}`);
    console.log(`    Unique Chunks Processed: ${seenChunkIndices.size} / ${chunks.length}`);
    console.log(`    Wave Progress Stage Events: ${waveProgressEvents.length}`);
    console.log(`    Manager Synthesis Calls: ${managerCalls}`);
    console.log(`    Manager Prompt Size: ~${managerPromptTokensReceived} tokens (provider ceiling: 6000)`);
    console.log(`    Swarm Run Status: ${result.status || 'complete'}`);

    // Invariant 1: Concurrency bounded by waveBatchSize (8)
    if (peakConcurrency > 8) {
        throw new Error(`FAIL: Peak concurrency (${peakConcurrency}) exceeded waveBatchSize limit (8)!`);
    }

    // Invariant 2: Zero chunk loss - all generated chunks evaluated
    if (seenChunkIndices.size !== chunks.length) {
        throw new Error(`FAIL: Chunk loss detected! Processed ${seenChunkIndices.size} of ${chunks.length} chunks.`);
    }

    // Invariant 3: All specialist seats participated
    if (analystRolesSeen.size !== 2) {
        throw new Error(`FAIL: Specialist starvation detected! Only saw roles: ${Array.from(analystRolesSeen).join(', ')}`);
    }

    // Invariant 4: Hierarchical wave scheduling emitted progress events
    if (waveProgressEvents.length === 0) {
        throw new Error(`FAIL: No wave_progress events emitted during multi-wave processing.`);
    }

    // Invariant 5: Context ceiling protection prevented manager prompt overflow
    if (managerPromptTokensReceived > 6500) {
        throw new Error(`FAIL: Manager prompt token count (~${managerPromptTokensReceived}) exceeded context safety ceiling.`);
    }

    // Invariant 6: Final analysis structured output
    if (!result.finalAnalysis || !result.finalAnalysis.ui_title || !result.finalAnalysis.components) {
        throw new Error(`FAIL: Final analysis missing expected structured components.`);
    }

    // Invariant 7: Workflow status is complete
    if (result.status === 'partial') {
        throw new Error(`FAIL: Swarm workflow completed with degraded/partial status: ${JSON.stringify(result.degraded)}`);
    }

    console.log('\n================================================================');
    console.log('  50k-ROW STRESS SIMULATION VERIFICATION PASSED WITH ZERO LOSS! ');
    console.log('================================================================\n');
}

runLargeDataStressSimulation()
    .then(() => {
        process.exit(0);
    })
    .catch((err) => {
        console.error('\n>>> LARGE DATA STRESS SIMULATION FAILED:', err);
        process.exit(1);
    });
