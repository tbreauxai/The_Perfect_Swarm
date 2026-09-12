import { GoogleGenAI } from '@google/genai';
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
console.log("Fetching...");
ai.models.generateContent({
    model: 'gemini-3.1-pro-preview',
    contents: 'hello',
}).then(res => console.log("Success:", res)).catch(err => console.log("Error:", err.message));
