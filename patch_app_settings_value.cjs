const fs = require('fs');
let code = fs.readFileSync('src/App.tsx', 'utf-8');

code = code.replace(/value={settings.githubToken}/, `value={settings.githubToken || ''}`);
code = code.replace(/value={settings.geminiApiKey}/, `value={settings.geminiApiKey || ''}`);
code = code.replace(/value={settings.openRouterApiKey}/, `value={settings.openRouterApiKey || ''}`);
code = code.replace(/value={settings.groqApiKey}/, `value={settings.groqApiKey || ''}`);
code = code.replace(/value={settings.qdrantUrl}/, `value={settings.qdrantUrl || ''}`);
code = code.replace(/value={settings.qdrantApiKey}/, `value={settings.qdrantApiKey || ''}`);

fs.writeFileSync('src/App.tsx', code);
