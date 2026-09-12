const fs = require('fs');
let server = fs.readFileSync('server.ts', 'utf-8');

// Insert custom error handler right before app.listen / Vite fallback
const customErrorHandler = `
app.use((err: any, req: any, res: any, next: any) => {
    console.error('Express Global Error:', err);
    if (err instanceof SyntaxError && 'body' in err) {
        return res.status(400).json({ error: 'Invalid JSON payload. ' + err.message });
    }
    if (err.type === 'entity.too.large') {
        return res.status(413).json({ error: 'Payload too large. Try reducing the size of your input data.' });
    }
    res.status(err.status || 500).json({ error: err.message || 'Internal Server Error' });
});

`;

server = server.replace(
    '  if (process.env.NODE_ENV !== "production") {',
    customErrorHandler + '  if (process.env.NODE_ENV !== "production") {'
);

fs.writeFileSync('server.ts', server);
console.log("Express global error handler applied.");
