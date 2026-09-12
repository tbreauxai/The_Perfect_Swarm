import { QdrantClient } from '@qdrant/js-client-rest';
const url = process.env.QDRANT_URL;
const apiKey = process.env.QDRANT_API_KEY;
if(!url || !apiKey) { console.log("No Qdrant creds in env, getting from config"); }
const qdrant = new QdrantClient({ url, apiKey, checkCompatibility: false });
qdrant.getCollections().then(res => console.log(JSON.stringify(res, null, 2))).catch(err => console.log(err.message));
