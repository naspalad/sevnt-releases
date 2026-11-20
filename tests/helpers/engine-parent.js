'use strict';
// Helper process for the orphan test: starts the engine, reports pids, then idles until it is killed.
const { EngineSupervisor } = require('../../src/engine/engine-supervisor');
const { makeSupervisorOptions } = require('./engine-env');
(async () => {
  const sup = new EngineSupervisor(makeSupervisorOptions());
  const st = await sup.start();
  process.stdout.write(JSON.stringify({ parent: process.pid, engine: st.pid, state: st.state, port: st.port }) + '\n');
  setInterval(() => {}, 1000);
})();
