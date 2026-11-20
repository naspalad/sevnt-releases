'use strict';
const { run } = require('./test-runner');
run([require('./test-engine')]).then((r) => process.exit(r.failed > 0 ? 1 : 0)).catch((e) => { console.error(e); process.exit(1); });
