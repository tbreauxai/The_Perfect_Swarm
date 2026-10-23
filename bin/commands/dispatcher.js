import { printHelp } from './help.js';
import { runDoctor } from './doctor.js';
import { runInit } from './init.js';
import { runTask } from './run.js';
import { runExportMemory, runImportMemory } from './memory.js';
import { runProfile } from './profile.js';
import {
    runFeedbackStats,
    runDriftCheck,
    runPolicyInspect,
    runGraphInspect,
    runHypothesesInspect,
    runRatesInspect
} from './inspect.js';

export async function dispatchCliCommand(args) {
    const command = args[0] || '--help';

    switch (command) {
        case 'doctor':
            await runDoctor();
            break;
        case 'init':
            await runInit(args[1], args[2]);
            break;
        case 'run':
            await runTask(args[1], args.slice(2));
            break;
        case 'export-memory':
            await runExportMemory(args.slice(1));
            break;
        case 'import-memory':
            await runImportMemory(args[1], args.slice(2));
            break;
        case 'profile':
        case 'bench':
            await runProfile(args.slice(1));
            break;
        case 'feedback-stats':
            await runFeedbackStats(args.slice(1));
            break;
        case 'drift-check':
            await runDriftCheck();
            break;
        case 'policy-inspect':
            await runPolicyInspect();
            break;
        case 'graph-inspect':
            await runGraphInspect();
            break;
        case 'hypotheses-inspect':
            await runHypothesesInspect();
            break;
        case 'rates-inspect':
            await runRatesInspect();
            break;
        case '--help':
        case '-h':
        default:
            printHelp();
            break;
    }
}
