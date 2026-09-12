const fs = require('fs');
let appTsx = fs.readFileSync('src/App.tsx', 'utf-8');

// Patch 1: Make /api/config/status safe
appTsx = appTsx.replace(
    "fetch('/api/config/status').then(res => res.json()).then(data => setEnvStatus(data)).catch(console.error);",
    "fetch('/api/config/status').then(res => res.text()).then(text => { try { setEnvStatus(JSON.parse(text)); } catch(e) { console.error('Config status parse error:', text); } }).catch(console.error);"
);

// Patch 2: Make the main response parse safe and diagnostic
const targetResponseJson = `      const resData = await response.json();
      setEvents(resData.events || []);
      setFinalAnalysis(resData.finalAnalysis || '');`;

const diagnosticResponse = `      const rawText = await response.text();
      let resData;
      try {
          resData = JSON.parse(rawText);
      } catch (parseError) {
          console.error("RAW SERVER RESPONSE:", rawText);
          throw new Error("The server returned HTML instead of JSON. Check the browser console for the 'RAW SERVER RESPONSE' to see what the server actually sent.");
      }
      setEvents(resData.events || []);
      setFinalAnalysis(resData.finalAnalysis || '');`;

if (appTsx.includes(targetResponseJson)) {
    appTsx = appTsx.replace(targetResponseJson, diagnosticResponse);
    fs.writeFileSync('src/App.tsx', appTsx);
    console.log("Diagnostic patch applied successfully.");
} else {
    console.log("Could not find the target string in App.tsx.");
}
