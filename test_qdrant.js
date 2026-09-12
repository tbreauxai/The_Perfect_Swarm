import { QdrantClient } from '@qdrant/js-client-rest';
const url = 'https://3b47d163-47ab-4447-8971-d53dfd7b4782.us-central1-0.gcp.cloud.qdrant.io/collections';
const qdrant = new QdrantClient({ url, checkCompatibility: false });
console.log("Fetching...");
qdrant.getCollections().then(res => console.log("Success:", res)).catch(err => console.log("Error:", err));
