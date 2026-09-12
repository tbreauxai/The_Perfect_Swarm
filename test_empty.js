fetch('http://localhost:3000/api/swarm/analyze', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    task: "how can we improve the swarm",
    data: "",
    settings: {
        geminiApiKey: process.env.GEMINI_API_KEY || "fake_key_to_bypass"
    }
  })
}).then(async r => {
    console.log(r.status);
    console.log(await r.text());
}).catch(console.error);
