const fs = require('fs');
let appTsx = fs.readFileSync('src/App.tsx', 'utf-8');

const targetStr = `      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to execute swarm.');
      }`;

const replacementStr = `      if (!response.ok) {
        let errorMsg = 'Failed to execute swarm.';
        const errorText = await response.text();
        try {
            const errorData = JSON.parse(errorText);
            errorMsg = errorData.error || errorMsg;
        } catch (e) {
            errorMsg = \`Server Error (\${response.status}): \${errorText.substring(0, 100)}...\`;
        }
        throw new Error(errorMsg);
      }`;

if (appTsx.includes(targetStr)) {
    console.log("Patching App.tsx");
    appTsx = appTsx.replace(targetStr, replacementStr);
    fs.writeFileSync('src/App.tsx', appTsx);
} else {
    console.log("Could not find target in App.tsx");
}
