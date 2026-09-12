const fs = require('fs');
let app = fs.readFileSync('src/App.tsx', 'utf-8');

const target = `    try {
      const response = await fetch('/api/swarm/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task, data, settings })
      });`;

const replacement = `    // Prevent 50MB browser uploads from crashing the Express JSON parser or network request
    let safeData = data;
    if (safeData.length > 500000) {
        safeData = safeData.substring(0, 500000) + "\\n...[TRUNCATED TO 500KB FOR NETWORK/MEMORY SAFETY]...";
    }

    try {
      const response = await fetch('/api/swarm/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task, data: safeData, settings })
      });`;

if (app.includes(target)) {
    app = app.replace(target, replacement);
    fs.writeFileSync('src/App.tsx', app);
    console.log("Frontend truncation patch applied.");
} else {
    console.log("Could not find fetch block in App.tsx.");
}
