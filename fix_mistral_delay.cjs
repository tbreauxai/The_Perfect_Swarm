const fs = require('fs');
let code = fs.readFileSync('swarm.ts', 'utf-8');

const target = `                else if (this.provider === 'mistral') {
                    const messages: any[] = [];`;

const replacement = `                else if (this.provider === 'mistral') {
                    // Mistral Free Tier strict 1 Request Per Second limit prevention
                    await new Promise(resolve => setTimeout(resolve, 1500));
                    const messages: any[] = [];`;

if(code.includes('else if (this.provider === \'mistral\') {')) {
    code = code.replace(target, replacement);
    fs.writeFileSync('swarm.ts', code);
    console.log("Patched swarm.ts to add Mistral 1.5s pre-delay");
} else {
    console.log("Could not find target in swarm.ts");
}
