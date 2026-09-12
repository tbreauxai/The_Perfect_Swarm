const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf-8');

// Manager Model Hardcodes
code = code.replace(
    /lightModel = 'gemini-2\.5-flash';/g,
    "lightModel = settings?.geminiModel || 'gemini-2.5-pro';"
);
code = code.replace(
    /lightModel = 'llama-3\.1-8b-instant';/g,
    "lightModel = settings?.groqModel || 'llama-3.1-8b-instant';"
);
code = code.replace(
    /lightModel = 'google\/gemini-2\.5-flash';/g,
    "lightModel = settings?.openRouterModel || 'google/gemini-2.5-flash';"
);

fs.writeFileSync('server.ts', code);
console.log("Patched server.ts to use user-defined models for Manager");
