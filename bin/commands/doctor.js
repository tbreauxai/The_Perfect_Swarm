import { MemoryCortex } from '../../dist/swarm/memory.js';
import { ModelRouter } from '../../dist/swarm/router.js';
import { ProviderRegistry } from '../../dist/swarm/index.js';

export async function runDoctor() {
    console.log('\n=== Perfect Swarm Diagnostic Doctor ===\n');

    const keys = [
        { name: 'Gemini (15 RPM / 1M TPM Free)', env: 'GEMINI_API_KEY' },
        { name: 'Groq (30 RPM / 6K TPM Free)', env: 'GROQ_API_KEY' },
        { name: 'OpenRouter (Guaranteed :free endpoints)', env: 'OPENROUTER_API_KEY' },
        { name: 'Mistral (Small Free Tier)', env: 'MISTRAL_API_KEY' },
        { name: 'GitHub Models (150 RPD Free)', env: 'GITHUB_TOKEN' }
    ];

    console.log('Provider Credentials Status:');
    let keyCount = 0;
    for (const k of keys) {
        const hasKey = Boolean(process.env[k.env]);
        if (hasKey) keyCount++;
        console.log(`  [${hasKey ? '✓ READY' : '○ MISSING'}] ${k.name} (${k.env})`);
    }

    console.log(`\nActive Registered Provider Adapters:`);
    const adapters = ProviderRegistry.list();
    for (const a of adapters) {
        console.log(`  ✓ ${a}`);
    }

    console.log(`\nMemory Cortex Vector Engine:`);
    const cortex = new MemoryCortex({ defaultAppId: 'doctor-check' });
    console.log(`  [✓ READY] In-Memory Fallback: Active`);
    console.log(`  [${cortex.isQdrantAvailable ? '✓ READY' : '○ OFFLINE'}] Qdrant Vector Service: ${cortex.isQdrantAvailable ? 'Connected' : 'Unreachable (gracefully falling back to in-memory RRF)'}`);

    console.log(`\nModelRouter Recommended Endpoints:`);
    console.log(`  Instant (<10 tokens): ${ModelRouter.getRecommendedModel('instant', 'gemini')}`);
    console.log(`  Standard (~50 tokens): ${ModelRouter.getRecommendedModel('standard', 'groq')}`);
    console.log(`  Complex (>100 tokens): ${ModelRouter.getRecommendedModel('complex', 'openrouter')}`);

    console.log(`\nDiagnostic Summary: System is ready with ${keyCount} external keys and zero-cost local fallbacks.\n`);
}
