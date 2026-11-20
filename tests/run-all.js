'use strict';

const { run } = require('./test-runner');

async function main() {
  const suiteUpdate = require('./test-update-check');
  const suiteMachineId = require('./test-machine-id');
  const suiteSession = require('./test-session-manager');
  const suiteGateway = require('./test-mobile-gateway');
  const suiteMobileIpc5b = require('./test-mobile-ipc-5b');

  const result = await run([
    suiteUpdate,
    suiteMachineId,
    suiteSession,
    suiteGateway,
    suiteMobileIpc5b,
  ]);

  process.exit(result.failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
