const fs = require('fs');
let code = fs.readFileSync('src/App.tsx', 'utf-8');

code = code.replace(/geminiModel: 'gemini-3\.1-pro-preview'/g, "geminiModel: 'gemini-2.5-pro'");
code = code.replace(/<option value="gemini-3\.1-pro-preview">Gemini 3\.1 Pro Preview<\/option>/g, '<option value="gemini-2.5-pro">Gemini 2.5 Pro</option>');
code = code.replace(/<option value="gemini-3\.6-flash">Gemini 3\.6 Flash<\/option>/g, '<option value="gemini-2.5-flash">Gemini 2.5 Flash</option>');

fs.writeFileSync('src/App.tsx', code);
console.log("Patched src/App.tsx with stable gemini models");
