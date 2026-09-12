const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf-8');

const target = `                            anomalies: [],
                            summary: \`Failed to process: \${err.message || String(err)}\`
                        };`;

const replacement = `                            anomalies: [],
                            summary: \`Failed to process: \${err.message || String(err)}\${(String(err).includes('1300') || String(err).includes('429')) && analyst.provider === 'mistral' ? '\\n(Diagnosis: Mistral Free Tier limits are extremely strict [1 Request Per Second / low TPM]. If you are sending small payloads, your API key has likely exhausted its monthly free allowance. Check console.mistral.ai/limits)' : ''}\`
                        };`;

if(code.includes('anomalies: [],')) {
    code = code.replace(target, replacement);
    fs.writeFileSync('server.ts', code);
    console.log("Patched server.ts with better Mistral diagnostic error");
} else {
    console.log("Could not find target in server.ts");
}
