const fs = require('fs');
let code = fs.readFileSync('swarm.ts', 'utf-8');

const target = `                            anomalies: [],
                            summary: \`Failed to process: \${err.message || String(err)}\``;

const replacement = `                            anomalies: [],
                            summary: \`Failed to process: \${err.message || String(err)}\${String(err).includes('1300') || String(err).includes('429') ? ' (Note: Mistral Free Tier has very strict TPM/RPM limits. If this persists on small payloads, your account may have exhausted its monthly allowance. Check console.mistral.ai/limits)' : ''}\``;

if(code.includes('anomalies: [],')) {
    // Actually, this is in server.ts, not swarm.ts!
}
