#!/usr/bin/env node
// Builds the per-platform Python runtime that ships inside the installer (resources/engine-runtime/<platform>-<arch>/).
//
//   node scripts/build-engine-runtime.mjs --from-local-python "C:\...\Python311\python.exe"
//        Windows x64, OFFLINE: copies the interpreter's stdlib and ONLY the packages the engine needs from an installed CPython 3.11.
//        Used on the development machine. Provenance (versions, python.exe sha256) is written to runtime-manifest.json.
//
//   node scripts/build-engine-runtime.mjs --ci
//        Release/CI mode (Windows x64, macOS arm64, macOS x64): pinned python-build-standalone + hash-locked wheels from
//        scripts/engine-runtime.lock.json. Refuses to run while any hash in the lock file is still null â€” hashes must come from a
//        trusted download, they are never invented. NOT executed in the development environment (needs downloads and macOS runners).
//
// The result is verified with the runtime's own interpreter in an isolated environment (no PYTHONHOME/PYTHONPATH/user site).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const key = `${process.platform}-${process.arch}`;
const OUT = path.join(ROOT, 'build', 'engine-runtime', key);
const args = process.argv.slice(2);
const fail = (m) => { console.error(`engine-runtime: ${m}`); process.exit(1); };
const run = (cmd, a, o = {}) => spawnSync(cmd, a, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...o });
const sha256 = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

function copyDir(src, dst, skip = () => false) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (skip(e.name, s, e.isDirectory())) continue;
    if (e.isDirectory()) copyDir(s, d, skip); else fs.copyFileSync(s, d);
  }
}

if (args.includes('--ci')) {
  const lockPath = path.join(ROOT, 'scripts', 'engine-runtime.lock.json');
  if (!fs.existsSync(lockPath)) fail('scripts/engine-runtime.lock.json is missing (pinned URLs + SHA-256 of python-build-standalone and the wheel lock).');
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  const entry = lock.targets && lock.targets[key];
  if (!entry || !entry.sha256 || !entry.url) fail(`no pinned python runtime with a SHA-256 for ${key} in the lock file (never guessed). Fill it from a trusted download first.`);
  fail('CI mode is specified but not implemented/executed in this environment (no downloads performed, no macOS runner).');
}

const i = args.indexOf('--from-local-python');
if (i < 0 || !args[i + 1]) fail('usage: --from-local-python <path to python.exe>  |  --ci');
if (process.platform !== 'win32') fail('--from-local-python is only implemented for Windows; use --ci on macOS.');
const py = path.resolve(args[i + 1]);
if (!fs.existsSync(py)) fail(`python not found: ${py}`);
const home = path.dirname(py);

const probe = run(py, ['-c', 'import sys;print(sys.version.split()[0]);print(sys.maxsize>2**32)']);
if (probe.status !== 0) fail(`cannot run ${py}: ${probe.stderr}`);
const [pyVersion, is64] = probe.stdout.trim().split(/\r?\n/);
if (!/^3\.11\./.test(pyVersion) || is64 !== 'True') fail(`expected 64-bit CPython 3.11, got ${pyVersion} (64-bit: ${is64}). The engine wheels are pinned to cp311.`);

// 1) dependency closure of the engine (from the interpreter's installed packages)
const dep = run(py, [path.join(ROOT, 'engine', 'tools', 'list_deps.py'), 'fastapi', 'uvicorn[standard]', 'faster-whisper', 'yt-dlp']);
if (dep.status !== 0) fail(`dependency listing failed: ${dep.stderr.slice(0, 500)}`);
const deps = JSON.parse(dep.stdout);
if (deps.missing.length) console.warn(`engine-runtime: optional/unavailable distributions skipped: ${deps.missing.join(', ')}`);

console.log(`engine-runtime: python ${pyVersion} -> ${path.relative(ROOT, OUT)}`);
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

// 2) interpreter + standard library (no tests, no GUI, no pip)
for (const f of ['python.exe', 'python3.dll', 'python311.dll', 'vcruntime140.dll', 'vcruntime140_1.dll', 'LICENSE.txt']) {
  if (fs.existsSync(path.join(home, f))) fs.copyFileSync(path.join(home, f), path.join(OUT, f));
}
copyDir(path.join(home, 'DLLs'), path.join(OUT, 'DLLs'), (n) => /^(_tkinter|tcl|tk|_ctypes_test|_testcapi|_testbuffer|_testimportmultiple|_testinternalcapi|_testmultiphase|_xxtestfuzz|xxlimited|xxlimited_35)/i.test(n) || /\.lib$/.test(n));
const skipLib = (n, p, isDir) => isDir ? ['site-packages', 'test', 'tests', 'idlelib', 'tkinter', 'turtledemo', 'lib2to3', 'ensurepip', 'venv', '__pycache__', 'distutils'].includes(n) : /\.pyc$/.test(n) || n === 'turtle.py';
copyDir(path.join(home, 'Lib'), path.join(OUT, 'Lib'), skipLib);
fs.mkdirSync(path.join(OUT, 'Lib', 'site-packages'), { recursive: true });

// 3) only the packages the engine needs, exactly the files listed in their RECORD
let copied = 0;
for (const d of deps.dists) {
  for (const rel of d.files) {
    const s = path.join(d.base, rel);
    if (!fs.existsSync(s) || fs.statSync(s).isDirectory()) continue;
    const t = path.join(OUT, 'Lib', 'site-packages', rel);
    fs.mkdirSync(path.dirname(t), { recursive: true });
    fs.copyFileSync(s, t);
    copied++;
  }
}

// 4) prove it works on its own: isolated environment, started from an unrelated folder
const env = { ...process.env, PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1' };
delete env.PYTHONHOME; delete env.PYTHONPATH;
const check = run(path.join(OUT, 'python.exe'), ['-c',
  "import sys,fastapi,uvicorn,pydantic,faster_whisper,ctranslate2,av,numpy,onnxruntime,tokenizers,huggingface_hub,yt_dlp;" +
  "import json;print(json.dumps({'exe':sys.executable,'prefix':sys.prefix,'fw':faster_whisper.__version__ if hasattr(faster_whisper,'__version__') else 'n/a','paths_outside':[p for p in sys.path if p and 'engine-runtime' not in p.replace('\\\\','/') and 'python311.zip' not in p]}))"],
  { env, cwd: process.env.TEMP || '.' });
if (check.status !== 0) fail(`runtime self-check FAILED:\n${check.stderr.slice(-1500)}`);
const info = JSON.parse(check.stdout.trim().split(/\r?\n/).pop());
if (info.paths_outside.length) fail(`runtime leaks outside paths: ${info.paths_outside.join(', ')}`);

fs.writeFileSync(path.join(OUT, 'runtime-manifest.json'), JSON.stringify({
  mode: 'local-python', platform: process.platform, arch: process.arch, python: pyVersion, builtAt: new Date().toISOString(),
  pythonExeSha256: sha256(path.join(OUT, 'python.exe')), filesCopiedFromSitePackages: copied,
  packages: deps.dists.map((d) => `${d.name}==${d.version}`),
  note: 'Built offline from the developer machine interpreter. Release builds must use --ci (pinned, hash-locked).',
}, null, 2));
console.log(`engine-runtime: OK â€” ${deps.dists.length} packages, ${copied} files, self-check passed (${info.exe})`);


