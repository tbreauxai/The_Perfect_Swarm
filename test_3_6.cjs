const { GoogleGenAI } = require('@google/genai');
const dotenv = require('dotenv');

dotenv.config();

async function test() {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  try {
    const response = await ai.models.generateContent({
        model: 'gemini-3.6-flash',
        contents: 'reply with "ok"'
    });
    console.log("SUCCESS: " + response.text);
  } catch (e) {
    console.error("ERROR: " + e.message);
  }
}
test();
