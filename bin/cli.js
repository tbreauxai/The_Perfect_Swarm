#!/usr/bin/env node

import { dispatchCliCommand } from './commands/dispatcher.js';

const args = process.argv.slice(2);

dispatchCliCommand(args).catch(err => {
    console.error('[PerfectSwarm CLI Error]:', err.message || err);
    process.exit(1);
});
