import { GoogleGenAI } from '@google/genai';

try {
  const ai = new GoogleGenAI({ apiKey: 'MISSING_KEY' });
  console.log('Successfully initialized with MISSING_KEY');
} catch (err) {
  console.error('Failed to initialize with MISSING_KEY:', err);
}
