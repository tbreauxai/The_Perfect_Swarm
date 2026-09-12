const fs = require('fs');
const settings = JSON.parse(fs.readFileSync('localStorage_mock.json', 'utf-8').settings || '{}');
const key = process.env.MISTRAL_API_KEY || settings.mistralApiKey;
if(!key) { console.log("No key"); process.exit(1); }

fetch('https://api.mistral.ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
        model: 'mistral-small-latest',
        messages: [{ role: 'user', content: 'Hello' }]
    })
}).then(res => res.text()).then(console.log).catch(console.error);
