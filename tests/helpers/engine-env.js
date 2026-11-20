'use strict';
// Shared helpers for engine tests. The interpreter is a DEV/TEST override only (the product uses the bundled runtime).
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const CANDIDATES = [
  process.env.SEVNT_ENGINE_PYTHON,
  path.join(ROOT, 'build', 'engine-runtime', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'python.exe' : 'bin/python3'),
  // developer machine only: the venv of the former SEVNTY APP project (never referenced by product code)
  path.join(ROOT, '..', 'SEVNTY APP', '.venv', 'Scripts', 'python.exe'),
].filter(Boolean);

function findPython() { return CANDIDATES.find((p) => fs.existsSync(p)) || null; }

function makeSupervisorOptions(extra = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sevnt-engine-test-'));
  return Object.assign({
    pythonPath: findPython(),
    engineDir: path.join(ROOT, 'engine'),
    dataDir: path.join(tmp, 'data'),
    modelsDir: process.env.SEVNT_TEST_HF_HOME || path.join(os.homedir(), '.cache', 'huggingface'),
    lockFile: path.join(tmp, 'engine.lock'),
    healthTimeoutMs: 45000,
    log: () => {},
  }, extra);
}
module.exports = { ROOT, findPython, makeSupervisorOptions };
