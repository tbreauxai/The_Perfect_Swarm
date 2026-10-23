import { globalFeedbackEngine } from '../../dist/swarm/feedback.js';
import { globalKnowledgeGraph } from '../../dist/swarm/knowledgeGraph.js';
import { globalHypothesisLayer, globalLearningRateManager } from '../../dist/swarm/coordination.js';

export async function runFeedbackStats(rawArgs) {
    let appId = 'perfect-swarm';
    for (let i = 0; i < rawArgs.length; i++) {
        if (rawArgs[i] === '--app' && rawArgs[i + 1]) {
            appId = rawArgs[i + 1];
            i++;
        }
    }
    console.log(`\n=== Perfect Swarm Knowledge Repository & Feedback Insights ===\n`);
    const insights = globalFeedbackEngine.getKnowledgeRepository().getAggregatedInsights(appId);
    console.log(`Target Application:    ${appId}`);
    console.log(`Total Logged Runs:     ${insights.totalRuns}`);
    console.log(`Average Reward Score:  ${insights.avgReward}`);
    console.log(`Average Latency:       ${insights.avgDurationMs}ms`);
    console.log(`Total Tokens Saved:    ${insights.totalTokensSaved}`);
    console.log(`Drift Alerts Logged:   ${insights.driftAlertsCount}`);
    console.log(`\nBest Evolutionary Parameters:`);
    console.log(JSON.stringify(insights.bestParameters, null, 2));
    console.log(`\n✓ Feedback statistics retrieved successfully.\n`);
}

export async function runDriftCheck() {
    console.log(`\n=== Perfect Swarm Concept Drift Detector ===\n`);
    const alerts = globalFeedbackEngine.getDriftDetector().getAlerts();
    console.log(`Active Drift Alerts: ${alerts.length}`);
    if (alerts.length === 0) {
        console.log(`✓ Zero drift detected across latency, quality, and semantic embedding streams.\n`);
    } else {
        for (const alert of alerts) {
            console.log(`  [${alert.severity.toUpperCase()}] ${alert.driftType} on '${alert.metric}': ${alert.message}`);
            console.log(`    Recommended Action: ${alert.recommendedAction}`);
        }
        console.log('');
    }
}

export async function runPolicyInspect() {
    console.log(`\n=== Perfect Swarm Evolutionary Policy Inspector ===\n`);
    const current = globalFeedbackEngine.getPolicyOptimizer().getCurrentPolicy();
    const best = globalFeedbackEngine.getPolicyOptimizer().getBestPolicy();
    console.log(`Current Active Tuned Parameters:`);
    console.log(JSON.stringify(current, null, 2));
    console.log(`\nBest Historical Policy Parameters:`);
    console.log(JSON.stringify(best, null, 2));
    console.log(`\n✓ Policy parameters inspected successfully.\n`);
}

export async function runGraphInspect() {
    console.log(`\n=== Perfect Swarm Shared Knowledge Graph Inspector ===\n`);
    const stats = globalKnowledgeGraph.getStats();
    console.log(`Knowledge Graph Status:`);
    console.log(`  Version: ${stats.version}`);
    console.log(`  Total Nodes: ${stats.totalNodes}`);
    console.log(`  Total Edges: ${stats.totalEdges}`);
    console.log(`  Node Types Distribution:`, JSON.stringify(stats.nodeTypes));
    console.log(`\n✓ Knowledge graph inspected successfully.\n`);
}

export async function runHypothesesInspect() {
    console.log(`\n=== Perfect Swarm Hypothesis Inspector ===\n`);
    const all = globalHypothesisLayer.getHypotheses();
    console.log(`Active Hypotheses Tracked: ${all.length}`);
    if (all.length === 0) {
        console.log(`  (No hypotheses currently registered)`);
    } else {
        for (const h of all) {
            console.log(`  [${h.status.toUpperCase()}] "${h.claim}" (Confidence: ${Math.round(h.confidence * 100)}%, Proposed by: ${h.proposedBy})`);
        }
    }
    console.log(`\n✓ Hypotheses inspected successfully.\n`);
}

export async function runRatesInspect() {
    console.log(`\n=== Perfect Swarm Agent Adaptive Learning Rates ===\n`);
    const states = globalLearningRateManager.getAllStates();
    console.log(`Tracked Agents: ${states.length}`);
    if (states.length === 0) {
        console.log(`  (Default initial learning rate: 0.10)`);
    } else {
        for (const s of states) {
            console.log(`  - ${s.agentId}: Rate=${s.learningRate}, EMA Reward=${s.emaReward}, Updates=${s.totalUpdates}`);
        }
    }
    console.log(`\n✓ Learning rates inspected successfully.\n`);
}
