const fs = require('fs');

async function check() {
    let key = process.env.MISTRAL_API_KEY;
    if (!key) {
        console.log("No MISTRAL_API_KEY in env, trying to find it in server context...");
        // the agent cannot read the user's localstorage.
        return;
    }
    const endpoint = 'https://api.mistral.ai/v1/chat/completions';
    const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${key}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: 'mistral-small-latest',
            messages: [{role: 'user', content: 'hello'}]
        })
    });
    console.log("Status:", response.status);
    console.log("Body:", await response.text());
}
check();
