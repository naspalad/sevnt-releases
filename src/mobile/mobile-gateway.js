// SEVNT Mobile Gateway — HTTP server that exposes SEVNT to companion devices.
// Only the Mobile Gateway port is exposed via tunnel — not the full Electron app.
// All endpoints (except /api/health and /api/pair) require a valid session token.
//
// LAN SECURITY NOTE:
// In LAN mode (HTTP, not HTTPS), session tokens travel unencrypted on the local network.
// This is a known limitation: a device on the same LAN could sniff tokens.
// Mitigations in place:
//   1. Tokens are short-lived (24h, revoked on app close).
//   2. The gateway only exposes SEVNT project data — not filesystem or admin ops.
//   3. The UI warns users about unencrypted LAN mode.
// Future improvement: self-signed TLS cert for LAN mode (tracked as TODO-LAN-TLS).

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { getPrimaryLanAddress, isLanAvailable } = require('./lan-detector');
const { createPairingToken, consumePairingToken, createSessionToken, verifySessionToken, rotateSessionToken, revokeAllSessions } = require('./session-manager');
const config = require('../sevnt-config');

const COMPANION_UI_PATH = path.join(__dirname, 'companion-ui.html');

// ─── Rate limiting ────────────────────────────────────────────────────────────

const _rateLimitMap = new Map();

function _rateLimit(ip) {
  const now = Date.now();
  let entry = _rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + 1000 };
    _rateLimitMap.set(ip, entry);
  }
  entry.count++;
  return entry.count <= config.MOBILE_RATE_LIMIT_RPS;
}

// ─── Auth middleware ──────────────────────────────────────────────────────────

async function _requireAuth(req, handlers) {
  const auth = req.headers['authorization'] || '';
  let token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token && req.method === 'GET' && String(req.url).startsWith('/api/media')) {   // <video src> cannot send headers
    try { token = new URL(req.url, 'http://x').searchParams.get('t'); } catch { token = null; }
  }
  if (!token) return null;

  // Get current license hash — if null, license is not valid and all sessions are denied
  let currentLicenseHash = null;
  try {
    currentLicenseHash = await Promise.resolve(handlers.getLicenseHash?.() ?? null);
  } catch {
    currentLicenseHash = null;
  }
  if (currentLicenseHash === null) return null;

  return verifySessionToken(token, currentLicenseHash);
}

// ─── Request router ───────────────────────────────────────────────────────────

async function _handleRequest(req, res, handlers) {
  const ip = req.socket.remoteAddress;

  if (!_rateLimit(ip)) {
    res.writeHead(429);
    res.end(JSON.stringify({ error: 'rate_limit_exceeded' }));
    return;
  }

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cache-Control', 'no-store');

  const url = new URL(req.url, `http://${req.headers.host}`);
  const route = `${req.method} ${url.pathname}`;

  // Serve companion UI at root (before auth check)
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    try {
      const html = fs.readFileSync(COMPANION_UI_PATH, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
    } catch {
      res.writeHead(503);
      res.end(JSON.stringify({ error: 'ui_not_found' }));
    }
    return;
  }

  // Brand assets for the phone UI: a fixed whitelist, nothing else on disk is reachable this way
  const ASSETS = { '/assets/logo-mark.png': ['brand/logo-mark.png', 'image/png'], '/assets/PlusJakartaSans.ttf': ['fonts/PlusJakartaSans-Variable.ttf', 'font/ttf'] };
  if (req.method === 'GET' && ASSETS[url.pathname]) {
    try {
      const buf = fs.readFileSync(path.join(__dirname, '..', '..', 'assets', ASSETS[url.pathname][0]));
      res.writeHead(200, { 'Content-Type': ASSETS[url.pathname][1], 'Cache-Control': 'public, max-age=86400' });
      res.end(buf);
    } catch { res.writeHead(404); res.end(JSON.stringify({ error: 'asset_not_found' })); }
    return;
  }
  // Public endpoints
  if (route === 'GET /api/health') {
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, app: config.APP_NAME }));
    return;
  }

  if (route === 'POST /api/pair') {
    _handlePair(req, res, url, handlers).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: 'internal_error' }));
      }
    });
    return;
  }

  // All other endpoints require auth
  const claims = await _requireAuth(req, handlers);
  if (!claims) {
    res.writeHead(401);
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return;
  }

  if (route === 'GET /api/projects') {
    const projects = handlers.getProjects?.() || [];
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, projects }));
    return;
  }

  if (route === 'POST /api/token/refresh') {
    // Token rotation — requires current license hash so revoked license invalidates refresh
    let currentLicenseHash = null;
    try {
      currentLicenseHash = await Promise.resolve(handlers.getLicenseHash?.() ?? null);
    } catch {
      currentLicenseHash = null;
    }
    if (!currentLicenseHash) {
      res.writeHead(403);
      res.end(JSON.stringify({ error: 'license_required' }));
      return;
    }
    const auth = req.headers['authorization'] || '';
    const oldToken = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    const newToken = oldToken ? rotateSessionToken(oldToken, currentLicenseHash) : null;
    if (!newToken) {
      res.writeHead(401);
      res.end(JSON.stringify({ error: 'token_rotation_failed' }));
      return;
    }
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, session_token: newToken }));
    return;
  }

  if (route === 'POST /api/disconnect') {
    // HP requests graceful disconnect
    revokeAllSessions();
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // POST /api/projects/:id/transcript — save edited transcript from HP
  if (req.method === 'POST' && url.pathname.match(/^\/api\/projects\/[^/]+\/transcript$/)) {
    _readBody(req, (body) => {
      const projectId = decodeURIComponent(url.pathname.split('/')[3]);
      // BUG-5B-004: handler validates projectId against known projects cache
      const transcript = (body && typeof body.transcript === 'string') ? body.transcript : '';
      const saved = handlers.saveTranscript?.({ projectId, transcript });
      if (saved === false) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'project_not_found' }));
        return;
      }
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }


  // ── Remote control of the desktop app (paste a link, follow progress, results, history, edits) ──
  if (route === 'GET /api/status') {
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, status: handlers.getStatus?.() || { running: false } }));
    return;
  }
  if (route === 'GET /api/clips') {
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, clips: handlers.getClips?.() || [] }));
    return;
  }
  if (route === 'GET /api/history') {
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, batches: handlers.getHistory?.() || [] }));
    return;
  }
  if (route === 'GET /api/settings') {
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, settings: handlers.getSettings?.() || {} }));
    return;
  }
  if (route === 'POST /api/settings') {
    _readBody(req, (body) => {
      const r = handlers.setSettings?.(body && typeof body === 'object' ? body : {});
      res.writeHead(r && r.ok === false ? 400 : 200);
      res.end(JSON.stringify(r || { ok: true }));
    });
    return;
  }
  if (route === 'POST /api/jobs') {
    _readBody(req, async (body) => {
      const u = body && typeof body.url === 'string' ? body.url.trim() : '';
      if (!/^https?:\/\/[^\s]{4,2000}$/i.test(u)) { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'url_invalid' })); return; }
      const r = await Promise.resolve(handlers.startJob?.(u)).catch(() => ({ ok: false, error: 'start_failed' }));
      res.writeHead(r && r.ok ? 200 : 409);
      res.end(JSON.stringify(r || { ok: false, error: 'not_supported' }));
    });
    return;
  }
  if (route === 'POST /api/jobs/cancel') {
    const r = handlers.cancelJob?.() || { ok: false };
    res.writeHead(200); res.end(JSON.stringify(r));
    return;
  }
  // POST /api/ops/:name — whitelisted desktop actions (render, frame, watermark text …); main validates them
  if (req.method === 'POST' && /^\/api\/ops\/[a-zA-Z]{2,24}$/.test(url.pathname)) {
    _readBody(req, async (body) => {
      const name = url.pathname.split('/')[3];
      const r = await Promise.resolve(handlers.runOp?.(name, body && typeof body === 'object' ? body : {})).catch(() => ({ ok: false, error: 'op_failed' }));
      res.writeHead(r && r.ok ? 200 : 400);
      res.end(JSON.stringify(r || { ok: false, error: 'not_supported' }));
    });
    return;
  }
  // POST /api/watermark/image?name=… — raw image bytes (PNG/WebP/JPEG, max 5 MB)
  if (route === 'POST /api/watermark/image') {
    const chunks = []; let size = 0, dead = false;
    req.on('data', (c) => { if (dead) return; size += c.length; if (size > 5 * 1024 * 1024) { dead = true; res.writeHead(413); res.end(JSON.stringify({ ok: false, error: 'too_large' })); req.destroy(); return; } chunks.push(c); });
    req.on('end', async () => {
      if (dead) return;
      const buf = Buffer.concat(chunks);
      const isImg = buf.length > 12 && ((buf[0] === 0x89 && buf[1] === 0x50) || (buf[0] === 0xff && buf[1] === 0xd8) || (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP'));
      if (!isImg) { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'not_an_image' })); return; }
      const r = await Promise.resolve(handlers.runOp?.('wmImage', { name: String(url.searchParams.get('name') || 'watermark').slice(0, 80), b64: buf.toString('base64') })).catch(() => ({ ok: false, error: 'op_failed' }));
      res.writeHead(r && r.ok ? 200 : 400); res.end(JSON.stringify(r || { ok: false }));
    });
    return;
  }
  if (req.method === 'GET' && /^\/api\/clips\/[^/]+\/cues$/.test(url.pathname)) {
    const id = decodeURIComponent(url.pathname.split('/')[3]);
    const r = handlers.getCues?.({ id });
    res.writeHead(r ? 200 : 404);
    res.end(JSON.stringify(r || { ok: false, error: 'not_found' }));
    return;
  }
  if (req.method === 'POST' && /^\/api\/clips\/[^/]+\/cues$/.test(url.pathname)) {
    _readBody(req, (body) => {
      const id = decodeURIComponent(url.pathname.split('/')[3]);
      const r = handlers.saveCues?.({ id, cues: body && body.cues });
      res.writeHead(r && r.ok ? 200 : 404);
      res.end(JSON.stringify(r || { ok: false, error: 'not_found' }));
    });
    return;
  }
  // GET /api/media?id=…  — stream a delivered clip (HTTP Range, so the phone can scrub)
  if (route === 'GET /api/media') {
    const file = handlers.getMediaPath?.(url.searchParams.get('id') || '');
    let st = null; try { st = file ? fs.statSync(file) : null; } catch { st = null; }
    if (!st || !st.isFile()) { res.writeHead(404); res.end(JSON.stringify({ error: 'media_not_found' })); return; }
    const type = /\.webm$/i.test(file) ? 'video/webm' : /\.mov$/i.test(file) ? 'video/quicktime' : 'video/mp4';
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    let start = 0, end = st.size - 1, code = 200;
    if (m) { if (m[1] !== '') start = +m[1]; if (m[2] !== '') end = Math.min(+m[2], st.size - 1); if (m[1] === '' && m[2] !== '') { start = Math.max(0, st.size - +m[2]); end = st.size - 1; } code = 206; }
    if (start > end || start >= st.size) { res.writeHead(416, { 'Content-Range': 'bytes */' + st.size }); res.end(); return; }
    const h = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Cache-Control': 'private, max-age=60' };
    if (code === 206) h['Content-Range'] = 'bytes ' + start + '-' + end + '/' + st.size;
    if (url.searchParams.get('dl') === '1') {
      const nm = String(url.searchParams.get('name') || 'sevnt-clip').replace(/[^\w\- ]+/g, '').trim().slice(0, 60) || 'sevnt-clip';
      h['Content-Disposition'] = 'attachment; filename="' + nm + path.extname(file).toLowerCase() + '"';
    }
    res.writeHead(code, h);
    const rs = fs.createReadStream(file, { start, end });
    rs.on('error', () => { try { res.destroy(); } catch {} });
    res.on('close', () => rs.destroy());
    rs.pipe(res);
    return;
  }

  // Unknown endpoint — 404 for authenticated requests
  res.writeHead(404);
  res.end(JSON.stringify({ error: 'not_found' }));
}

function _readBody(req, cb) {
  let raw = '';
  req.on('data', chunk => { raw += chunk; if (raw.length > 65536) raw = raw.slice(0, 65536); });
  req.on('end', () => {
    try { cb(JSON.parse(raw)); } catch { cb(null); }
  });
}

async function _handlePair(req, res, url, handlers) {
  const token = url.searchParams.get('t');
  if (!token || !consumePairingToken(token)) {
    res.writeHead(400);
    res.end(JSON.stringify({ error: 'invalid_or_expired_pairing_token' }));
    return;
  }

  // Notify desktop UI to show confirmation dialog.
  // Default: reject if no handler is wired up (safe default — requires explicit confirmation).
  if (typeof handlers.onPairRequest !== 'function') {
    res.writeHead(503);
    res.end(JSON.stringify({ error: 'pairing_handler_not_ready' }));
    return;
  }

  // BUG-5B4-001 fix: await the Promise returned by onPairRequest.
  // Previously the Promise object itself (always truthy) was used directly,
  // bypassing user confirmation. Now we wait for the actual approval decision.
  let confirmed;
  try {
    confirmed = await handlers.onPairRequest(req.socket.remoteAddress);
  } catch {
    // Handler threw — treat as rejection; do not create session
    res.writeHead(403);
    res.end(JSON.stringify({ error: 'pairing_rejected' }));
    return;
  }

  if (!confirmed) {
    res.writeHead(403);
    res.end(JSON.stringify({ error: 'pairing_rejected' }));
    return;
  }

  // Verify license is still active at the moment of pairing
  let licenseHash;
  try {
    licenseHash = await Promise.resolve(handlers.getLicenseHash?.() ?? null);
  } catch {
    licenseHash = null;
  }
  if (!licenseHash) {
    res.writeHead(403);
    res.end(JSON.stringify({ error: 'license_required' }));
    return;
  }

  const deviceId = req.headers['x-device-id'] || req.socket.remoteAddress;
  const sessionToken = createSessionToken(deviceId, licenseHash);

  res.writeHead(200);
  res.end(JSON.stringify({ ok: true, session_token: sessionToken }));
}

// ─── Gateway class ────────────────────────────────────────────────────────────

class MobileGateway {
  constructor(handlers = {}, port) {
    this._handlers = handlers;
    this._server = null;
    this._port = port || parseInt(process.env.SEVNT_MOBILE_PORT, 10) || config.MOBILE_GATEWAY_PORT;
  }

  /**
   * Starts the HTTP server on the mobile gateway port.
   * Returns { lanUrl } if LAN is available.
   */
  async start() {
    if (this._server) return this._getUrls();

    this._server = http.createServer((req, res) => {
      _handleRequest(req, res, this._handlers).catch(() => {
        if (!res.headersSent) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: 'internal_error' }));
        }
      });
    });

    await new Promise((resolve, reject) => {
      this._server.listen(this._port, '0.0.0.0', resolve);
      this._server.once('error', reject);
    });

    return this._getUrls();
  }

  _getUrls() {
    const lan = isLanAvailable()
      ? `http://${getPrimaryLanAddress()}:${this._port}`
      : null;
    return { lanUrl: lan, port: this._port };
  }

  /**
   * Creates a new pairing token and returns the pairing URL.
   * tunnelUrl is the remote tunnel URL if available.
   */
  createPairingUrl(tunnelUrl) {
    const { token } = createPairingToken();
    const base = tunnelUrl || this._getUrls().lanUrl;
    if (!base) throw new Error('No URL available — start tunnel or ensure LAN is connected');
    return { pairingUrl: `${base}/?t=${token}`, token };
  }

  /**
   * Stops the server and revokes all sessions.
   */
  async stop() {
    revokeAllSessions();
    if (this._server) {
      await new Promise(resolve => this._server.close(resolve));
      this._server = null;
    }
  }

  get isRunning() { return !!this._server; }
  get port() { return this._port; }
}

module.exports = { MobileGateway };
