const fs = require('fs');
let pkg = JSON.parse(fs.readFileSync('package.json', 'utf-8'));
pkg.scripts.dev = "tsx watch server.ts";
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2));
