const fs = require('fs');
let server = fs.readFileSync('server.ts', 'utf-8');

const targetStr = `            } catch (err: any) {
                const errorMessage = err.message || String(err);
                
                // Add the failure directly into the Swarm UI context so you can see exactly why Qdrant failed`;

const replacementStr = `            } catch (err: any) {
                let errorMessage = err.message || String(err);
                
                if (errorMessage.includes("Unexpected token '<'") || errorMessage.includes("is not valid JSON")) {
                    errorMessage = "The Qdrant URL provided is returning an HTML web page instead of a JSON API response. Ensure you are using the Cluster REST Endpoint URL (e.g. https://your-cluster...gcp.cloud.qdrant.tech:6333) and not the Qdrant Cloud Dashboard URL.";
                }

                // Add the failure directly into the Swarm UI context so you can see exactly why Qdrant failed`;

if (server.includes(targetStr)) {
    server = server.replace(targetStr, replacementStr);
    fs.writeFileSync('server.ts', server);
    console.log("Qdrant error message patched.");
} else {
    console.log("Could not find target string.");
}
