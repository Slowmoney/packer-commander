#!/usr/bin/env node
'use strict';

const { main } = require('../src/cli.js');

const { code, running } = main();
if (!running) {
    process.exit(code);
}
