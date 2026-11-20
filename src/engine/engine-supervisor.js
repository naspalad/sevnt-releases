'use strict';
// EngineSupervisor — the ONLY code that starts, watches, talks to and stops the local Python engine.
// Electron-free on purpose (paths are injected) so it can be tested with plain Node.
//
// Guarantees:
//  - dynamic loopback port (the engine picks it and reports it), per-launch bearer token
//  - health check with timeout before the engine is called "ready"
//  - bounded automatic restart on crash, then state "unavailable" (callers fall back to whisper.cpp)
//  - graceful shutdown (POST /shutdown) then process-tree kill; no orphan after stop()
//  - lock file + parent-pid watchdog inside the engine protect against orphans after a crash of the app

const { EventEmitter } = require('events');
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const STATES = { STOPPED: 'stopped', STARTING: 'starting', READY: 'ready', UNAVAILABLE: 'unavailable' };

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function imageName(pid) {
  try {
    if (process.platform === 'win32') {
      const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
      return (r.stdout || '').trim().split('","')[0].replace(/^"/, '').toLowerCase();
    }
    const r = spawnSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8', timeout: 5000 });
    return (r.stdout || '').trim().toLowerCase();
  } catch { return ''; }
}

function killTree(pid) {
  if (!pidAlive(pid)) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 10000 });
  } else {
    try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class EngineSupervisor extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.pythonPath      interpreter of the bundled (or dev-override) runtime
   * @param {string} o.engineDir       folder that contains the `sevnt_engine` package
   * @param {string} o.dataDir         SEVNT_DATA_DIR
   * @param {string} [o.modelsDir]     HF_HOME for faster-whisper models
   * @param {string} [o.ffmpegPath]    A's bundled ffmpeg (never duplicated)
   * @param {string} [o.ffprobePath]
   * @param {string} o.lockFile        e.g. <userData>/engine.lock
   * @param {number} [o.healthTimeoutMs=60000]
   * @param {number} [o.maxRestarts=3]
   * @param {number} [o.restartWindowMs=300000]
   * @param {(msg:string)=>void} [o.log]
   */
  constructor(o) {
    super();
    this.o = Object.assign({ healthTimeoutMs: 60000, maxRestarts: 3, restartWindowMs: 300000, log: () => {} }, o);
    this.state = STATES.STOPPED;
    this.port = 0;
    this.pid = 0;
    this.token = '';
    this.error = null;
    this.child = null;
    this.stopping = false;
    this.crashTimes = [];
    this._exitWaiters = [];
  }

  get status() {
    return { state: this.state, port: this.port || null, pid: this.pid || null, error: this.error, restarts: this.crashTimes.length };
  }

  _set(state, error = null) {
    this.state = state; this.error = error;
    this.emit('status', this.status);
  }

  _validate() {
    const { pythonPath, engineDir } = this.o;
    if (!pythonPath || !fs.existsSync(pythonPath)) return { code: 'runtime_missing', message: 'Runtime Python engine tidak ditemukan' };
    if (!engineDir || !fs.existsSync(path.join(engineDir, 'sevnt_engine', 'server.py'))) return { code: 'engine_missing', message: 'Kode engine tidak ditemukan' };
    return null;
  }

  /** Kill a leftover engine from a crashed previous session (only if it is verifiably ours and orphaned). */
  reapStale() {
    const f = this.o.lockFile;
    let lock;
    try { lock = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return false; }
    let reaped = false;
    if (lock && pidAlive(lock.enginePid) && !pidAlive(lock.parentPid) && /python/.test(imageName(lock.enginePid))) {
      killTree(lock.enginePid);
      reaped = true;
      this.o.log(`engine: menghentikan sisa proses engine lama (pid ${lock.enginePid})`);
    }
    try { fs.unlinkSync(f); } catch { /* already gone */ }
    return reaped;
  }

  async start() {
    if (this.state === STATES.STARTING || this.state === STATES.READY) return this.status;
    this.stopping = false;
    const bad = this._validate();
    if (bad) { this._set(STATES.UNAVAILABLE, bad); return this.status; }
    this.reapStale();
    return this._launch();
  }

  async _launch() {
    this._set(STATES.STARTING);
    this.token = crypto.randomBytes(32).toString('hex');
    this.port = 0;
    const o = this.o;
    const env = Object.assign({}, process.env, {
      PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8',
      SEVNT_ENGINE_TOKEN: this.token, SEVNT_PARENT_PID: String(process.pid), SEVNT_ENGINE_PORT: '0',
      SEVNT_DATA_DIR: o.dataDir,
    });
    delete env.PYTHONHOME; delete env.PYTHONPATH;
    if (o.modelsDir) env.HF_HOME = o.modelsDir;
    if (o.ffmpegPath) env.SEVNT_FFMPEG = o.ffmpegPath;
    if (o.ffprobePath) env.SEVNT_FFPROBE = o.ffprobePath;

    let child;
    try {
      child = spawn(o.pythonPath, ['-m', 'sevnt_engine.server'], {
        cwd: o.engineDir, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
      });
    } catch (e) {
      this._set(STATES.UNAVAILABLE, { code: 'spawn_failed', message: e.message });
      return this.status;
    }
    this.child = child;
    this.pid = child.pid || 0;
    let buf = '';
    const onLine = (line) => {
      line = line.trim(); if (!line) return;
      if (line.startsWith('{')) {
        try {
          const ev = JSON.parse(line);
          if (ev.event === 'listening') { this.port = ev.port; return; }
          if (ev.event === 'error') { this._startupError = ev.message; return; }
        } catch { /* not an event */ }
      }
      this.o.log(`engine: ${line.slice(0, 300)}`);
    };
    child.stdout.on('data', (d) => { buf += d.toString('utf8'); let i; while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); } });
    child.stderr.on('data', (d) => { String(d).split(/\r?\n/).forEach((l) => l.trim() && this.o.log(`engine[err]: ${l.slice(0, 300)}`)); });
    child.on('error', (e) => { if (this.child === child) this._set(STATES.UNAVAILABLE, { code: 'spawn_failed', message: e.message }); });
    child.on('exit', (code, sig) => this._onExit(child, code, sig));

    const deadline = Date.now() + o.healthTimeoutMs;
    let delay = 100;
    while (Date.now() < deadline) {
      if (this.child !== child || this.stopping) return this.status;
      if (this.port) {
        try {
          const h = await this._http('GET', '/health', undefined, 2000, false);
          if (h && h.status === 'ok') {
            try { fs.mkdirSync(path.dirname(o.lockFile), { recursive: true }); fs.writeFileSync(o.lockFile, JSON.stringify({ enginePid: this.pid, parentPid: process.pid, port: this.port, startedAt: Date.now() })); } catch { /* non-fatal */ }
            this._set(STATES.READY);
            return this.status;
          }
        } catch { /* not up yet */ }
      }
      await sleep(delay); delay = Math.min(delay * 1.6, 1000);
    }
    killTree(this.pid);
    this._set(STATES.UNAVAILABLE, { code: 'health_timeout', message: this._startupError || 'Engine tidak merespons health check' });
    return this.status;
  }

  _onExit(child, code, sig) {
    this._exitWaiters.splice(0).forEach((fn) => fn());
    if (this.child !== child) return;
    this.child = null; this.pid = 0; this.port = 0;
    try { fs.unlinkSync(this.o.lockFile); } catch { /* none */ }
    if (this.stopping) { this._set(STATES.STOPPED); return; }
    const now = Date.now();
    this.crashTimes = this.crashTimes.filter((t) => now - t < this.o.restartWindowMs); this.crashTimes.push(now);
    this.o.log(`engine: berhenti tak terduga (code ${code}, signal ${sig})`);
    if (this.crashTimes.length > this.o.maxRestarts) {
      this._set(STATES.UNAVAILABLE, { code: 'crash_loop', message: `Engine berhenti berulang kali (kode ${code})` });
      return;
    }
    const wait = 1000 * 2 ** (this.crashTimes.length - 1);
    this._set(STATES.STARTING);
    setTimeout(() => { if (!this.stopping && this.state === STATES.STARTING) this._launch(); }, wait);
  }

  async stop() {
    this.stopping = true;
    const child = this.child;
    if (!child) { this._set(STATES.STOPPED); try { fs.unlinkSync(this.o.lockFile); } catch { /* none */ } return; }
    const exited = new Promise((res) => this._exitWaiters.push(res));
    try { if (this.port) await this._http('POST', '/api/v1/shutdown', {}, 1500); } catch { /* fall through to kill */ }
    const ok = await Promise.race([exited.then(() => true), sleep(3000).then(() => false)]);
    if (!ok) { killTree(this.pid); await Promise.race([exited, sleep(2000)]); }
    this.child = null; this.pid = 0; this.port = 0;
    try { fs.unlinkSync(this.o.lockFile); } catch { /* none */ }
    this._set(STATES.STOPPED);
  }

  /** Synchronous last-resort kill for process 'exit' handlers. */
  killNow() { this.stopping = true; if (this.pid) killTree(this.pid); try { fs.unlinkSync(this.o.lockFile); } catch { /* none */ } }

  async _http(method, urlPath, body, timeoutMs = 10000, auth = true) {
    if (!this.port) throw new Error('engine port unknown');
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(`http://127.0.0.1:${this.port}${urlPath}`, {
        method, signal: ctl.signal,
        headers: Object.assign({ Accept: 'application/json' }, body !== undefined ? { 'Content-Type': 'application/json' } : {}, auth ? { Authorization: `Bearer ${this.token}` } : {}),
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
      if (!res.ok) { const err = new Error((json && (json.message || json.error)) || `HTTP ${res.status}`); err.status = res.status; err.code = json && json.error; throw err; }
      return json;
    } finally { clearTimeout(timer); }
  }

  /** Authenticated request to the running engine. Rejects when the engine is not ready. */
  request(method, urlPath, body, timeoutMs) {
    if (this.state !== STATES.READY) return Promise.reject(Object.assign(new Error('engine not ready'), { code: 'engine_unavailable' }));
    return this._http(method, urlPath, body, timeoutMs, true);
  }
}

module.exports = { EngineSupervisor, STATES, pidAlive, killTree };
