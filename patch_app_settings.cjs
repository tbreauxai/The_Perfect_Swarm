const fs = require('fs');
let code = fs.readFileSync('src/App.tsx', 'utf-8');

code = code.replace(/setSettings\(JSON\.parse\(saved\)\);/, 
`const parsed = JSON.parse(saved);
        setSettings(prev => ({ ...prev, ...parsed }));`);

fs.writeFileSync('src/App.tsx', code);
