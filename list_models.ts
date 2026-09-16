import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';

dotenv.config();

async function run() {
    console.log("Fetching Gemini models...");
    const client = new GoogleGenAI({
        apiKey: process.env.GEMINI_API_KEY || 'MISSING'
    });

    try {
        const response = await client.models.list();
        const embeddingModels = [];
        for await (const model of response) {
            const name = model.name;
            const methods = (model as any).supportedGenerationMethods || [];
            if (name.includes('embed') || methods.includes('embedContent')) {
                embeddingModels.push({ name, methods });
            }
        }
        console.log("Embedding Models:", JSON.stringify(embeddingModels, null, 2));
    } catch (err: any) {
        console.error("Error fetching models:", err.message);
    }
}

run();
