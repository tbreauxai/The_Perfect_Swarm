import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';

dotenv.config();

async function test() {
    console.log("Testing gemini-3.5-flash...");
    const client = new GoogleGenAI({
        apiKey: process.env.GEMINI_API_KEY || 'MISSING_KEY'
    });

    try {
        const response = await client.models.generateContent({
            model: 'gemini-3.5-flash',
            contents: 'Hello, world!'
        });
        console.log("Success:", response.text);
    } catch (err: any) {
        console.error("Error:", err.message);
    }
}

test();
