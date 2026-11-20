// SEVNT Studio — Telegram delivery (main process).
// Sends finished clips to a Telegram chat through the user's OWN bot.
//
// Security:
//   - The bot token lives only here (userData/sevnt-studio/telegram.json, encrypted with the OS
//     keychain via safeStorage when available). The renderer can save or clear it and gets a masked
//     hint back, never the token itself.
//   - Only api.telegram.org is contacted, only with this token, and only to send what the user exports.
//   - The renderer passes file paths; they are checked to be existing regular video files first.

'use strict';

const { ipcMain, app, safeStorage } = require('electron');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');

const API = 'https://api.telegram.org';
const MAX_BYTES = 50 * 1024 * 1024;          // Bot API upload limit
const VIDEO_EXT = /\.(mp4|mov|m4v|webm|mkv)$/i;

function storePath() {
  const dir = path.join(app.getPath('userData'), 'sevnt-studio');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* exists */ }
  return path.join(dir, 'telegram.json');
}
function readStore() {
  try {
    const j = JSON.parse(fs.readFileSync(storePath(), 'utf8'));
    let token = '';
    if (j.enc && safeStorage.isEncryptionAvailable()) token = safeStorage.decryptString(Buffer.from(j.token, 'base64'));
    else if (!j.enc) token = String(j.token || '');
    return { token, chatId: String(j.chatId || ''), botName: String(j.botName || '') };
  } catch { return { token: '', chatId: '', botName: '' }; }
}
function writeStore({ token, chatId, botName }) {
  const enc = safeStorage.isEncryptionAvailable();
  const stored = enc ? safeStorage.encryptString(token).toString('base64') : token;
  fs.writeFileSync(storePath(), JSON.stringify({ enc, token: stored, chatId, botName }), { encoding: 'utf8', mode: 0o600 });
}
const hint = (t) => (t && t.length > 10 ? `${t.slice(0, 4)}…${t.slice(-4)}` : t ? '••••' : '');

// Telegram answers { ok, result | description }. Any failure becomes a short, readable Indonesian message.
// `body` is a FormData (file upload), a plain object (sent as JSON) or null (plain GET, e.g. getMe).
// An empty multipart body is rejected by Telegram with a bare "HTTP 400", so never send one.
async function call(token, method, body) {
  let res;
  try {
    const url = `${API}/bot${token}/${method}`;
    if (body instanceof FormData) res = await fetch(url, { method: 'POST', body });
    else if (body) res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    else res = await fetch(url);
  } catch (e) {
    throw new Error('Tidak bisa terhubung ke Telegram — cek koneksi internet.');
  }
  let j = null;
  try { j = await res.json(); } catch { /* not json */ }
  if (j && j.ok) return j.result;
  const d = (j && j.description) || `HTTP ${res.status}`;
  if (res.status === 401 || /unauthorized/i.test(d)) throw new Error('Token bot salah atau sudah dicabut.');
  if (/chat not found/i.test(d)) throw new Error('ID Telegram tidak ditemukan. Buka bot Anda di Telegram dan tekan Start dulu, lalu coba lagi.');
  if (/bot was blocked|forbidden/i.test(d)) throw new Error('Bot tidak boleh mengirim ke chat ini. Buka bot di Telegram dan tekan Start.');
  if (/too large|entity too large/i.test(d)) throw new Error('File melebihi batas 50 MB Telegram.');
  throw new Error(`Telegram menolak (${res.status}): ${d}`);
}
const form = (obj) => { const f = new FormData(); for (const [k, v] of Object.entries(obj)) f.append(k, String(v)); return f; };

const cleanToken = (t) => String(t || '').trim();
const cleanChat = (c) => String(c || '').trim();

ipcMain.handle('telegram:status', () => {
  const s = readStore();
  return { configured: !!(s.token && s.chatId), chatId: s.chatId, botName: s.botName, tokenHint: hint(s.token) };
});

// Verify the token (getMe) and the chat id (a test message) BEFORE saving anything.
ipcMain.handle('telegram:save', async (_e, payload) => {
  const token = cleanToken(payload && payload.token);
  const chatId = cleanChat(payload && payload.chatId);
  if (!/^\d{6,12}:[A-Za-z0-9_-]{30,}$/.test(token)) return { ok: false, error: 'Format token bot tidak benar. Contoh: 123456789:AAH… (dari @BotFather).' };
  if (!/^-?\d{4,20}$/.test(chatId)) return { ok: false, error: 'ID Telegram harus berupa angka. Contoh: 123456789.' };
  try {
    const me = await call(token, 'getMe', null);
    await call(token, 'sendMessage', { chat_id: chatId, text: '✅ SEVNT Studio terhubung. Hasil export akan dikirim ke chat ini.' });
    const botName = me && me.username ? `@${me.username}` : '';
    writeStore({ token, chatId, botName });
    return { ok: true, botName, chatId, tokenHint: hint(token) };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
});

ipcMain.handle('telegram:clear', () => {
  try { fs.unlinkSync(storePath()); } catch { /* already gone */ }
  return { ok: true };
});

// ── MP4 header probe: real width / height / duration, so Telegram shows the right shape everywhere ──
// Without these Telegram's iPhone app lays the video out as a square (Android reads the file itself).
function probeMp4(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const read = (pos, len) => { const b = Buffer.alloc(len); const n = fs.readSync(fd, b, 0, len, pos); return n < len ? b.subarray(0, n) : b; };
    let pos = 0, moov = null;
    while (pos + 8 <= size) {
      const h = read(pos, 16);
      if (h.length < 8) break;
      let sz = h.readUInt32BE(0); const type = h.toString('latin1', 4, 8); let hdr = 8;
      if (sz === 1 && h.length >= 16) { sz = Number(h.readBigUInt64BE(8)); hdr = 16; } else if (sz === 0) sz = size - pos;
      if (sz < 8) break;
      if (type === 'moov') { moov = read(pos + hdr, Math.min(sz - hdr, 24 * 1024 * 1024)); break; }
      pos += sz;
    }
    if (!moov) return null;
    let width = 0, height = 0, duration = 0;
    const walk = (buf, s, e) => {
      let p = s;
      while (p + 8 <= e) {
        let sz = buf.readUInt32BE(p); const type = buf.toString('latin1', p + 4, p + 8); let hdr = 8;
        if (sz === 1) { sz = Number(buf.readBigUInt64BE(p + 8)); hdr = 16; } else if (sz === 0) sz = e - p;
        if (sz < 8 || p + sz > e) break;
        const body = p + hdr;
        if (type === 'trak') walk(buf, body, p + sz);
        else if (type === 'tkhd') {
          const v = buf[body];
          const o = v === 1 ? body + 88 : body + 76;     // width/height are 16.16 fixed point
          if (o + 8 <= p + sz) { const w = buf.readUInt32BE(o) / 65536, h2 = buf.readUInt32BE(o + 4) / 65536; if (w > 0 && h2 > 0 && !width) { width = Math.round(w); height = Math.round(h2); } }
        } else if (type === 'mvhd' && !duration) {
          const v = buf[body];
          if (v === 1) { const ts = buf.readUInt32BE(body + 20), d = Number(buf.readBigUInt64BE(body + 24)); if (ts) duration = d / ts; }
          else { const ts = buf.readUInt32BE(body + 12), d = buf.readUInt32BE(body + 16); if (ts) duration = d / ts; }
        }
        p += sz;
      }
    };
    walk(moov, 0, moov.length);
    return width && height ? { width, height, duration: Math.round(duration) } : null;
  } catch { return null; } finally { if (fd != null) { try { fs.closeSync(fd); } catch { /* closed */ } } }
}

// multipart upload with a real byte counter (fetch cannot report upload progress).
// Every failure is tagged with WHY (network vs. local file) and whether trying again can help.
const NET_CODES = new Set(['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'ECONNABORTED', 'UND_ERR_SOCKET', 'ERR_SOCKET_CLOSED']);
const BUSY_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'EMFILE', 'ENFILE']);   // file still locked right after the render (antivirus, ffmpeg)
function uploadVideo(token, fields, filePath, fileName, onProgress) {
  return new Promise((resolve, reject) => {
    const boundary = '----sevnt' + crypto.randomBytes(12).toString('hex');
    const text = Object.entries(fields).map(([k, v]) => `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`).join('');
    const safeName = String(fileName).replace(/[^\w.\- ]/g, '_');
    const head = Buffer.from(`${text}--${boundary}\r\nContent-Disposition: form-data; name="video"; filename="${safeName}"\r\nContent-Type: video/mp4\r\n\r\n`);
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    let total;
    try { total = fs.statSync(filePath).size; } catch (e) {
      reject(Object.assign(new Error('File video tidak bisa dibaca (' + (e.code || 'error') + ').'), { retryable: BUSY_CODES.has(e.code), code: e.code }));
      return;
    }
    let settled = false, resp = null, fileErr = null;
    const done = (fn, v) => { if (!settled) { settled = true; fn(v); } };
    const req = https.request({
      hostname: 'api.telegram.org', path: `/bot${token}/sendVideo`, method: 'POST', agent: false,
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': head.length + total + tail.length },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* not json */ }
        resp = { status: res.statusCode, json: j };
        done(resolve, resp);
      });
    });
    req.on('error', (e) => {
      if (resp) { done(resolve, resp); return; }          // Telegram already answered; the reset came after
      if (fileErr) {
        done(reject, Object.assign(new Error('File video tidak bisa dibaca (' + (fileErr.code || 'error') + ') — mungkin masih dipakai program lain.'), { retryable: BUSY_CODES.has(fileErr.code), code: fileErr.code }));
        return;
      }
      const code = e && e.code ? e.code : (e && e.message) || 'error';
      done(reject, Object.assign(new Error('Koneksi ke Telegram terputus (' + code + ') — cek internet.'), { retryable: NET_CODES.has(e && e.code) || /timeout/i.test(String(e && e.message)), code }));
    });
    req.setTimeout(10 * 60 * 1000, () => req.destroy(new Error('timeout')));
    req.write(head);
    let sent = 0;
    const rs = fs.createReadStream(filePath, { highWaterMark: 256 * 1024 });
    rs.on('data', (c) => {
      sent += c.length;
      if (!req.write(c)) { rs.pause(); req.once('drain', () => rs.resume()); }
      if (onProgress) onProgress(sent / total);
    });
    rs.on('end', () => req.end(tail));
    rs.on('error', (e) => { fileErr = e; req.destroy(e); });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// up to 3 tries: a dropped connection or a file that is still locked right after the render usually works a moment later
async function uploadWithRetry(token, fields, filePath, fileName, onProgress, onRetry) {
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await uploadVideo(token, fields, filePath, fileName, onProgress); }
    catch (e) {
      last = e;
      if (!e.retryable || attempt === 2) break;
      if (onRetry) onRetry(attempt + 2, e);
      await sleep(2500 * (attempt + 1));
    }
  }
  throw last;
}

const trim = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

// One file: post a "sending…" chat message, update it with the real percentage, remove it when the video is
// delivered (kept, with the reason, when it failed). Progress also goes to the app window.
async function sendOne(event, s, f, index, total) {
  const p = String(f.path || '');
  const name = path.basename(p);
  const title = trim(f.caption, 90);
  const emit = (pct, stage) => { try { event.sender.send('telegram:progress', { id: f.id, index, total, name, pct, stage }); } catch { /* window closed */ } };
  let statusId = null;
  const say = async (text) => {
    try {
      if (statusId) await call(s.token, 'editMessageText', { chat_id: s.chatId, message_id: statusId, text });
      else { const m = await call(s.token, 'sendMessage', { chat_id: s.chatId, text }); statusId = m && m.message_id; }
    } catch { /* cosmetic only */ }
  };
  try {
    const st = fs.statSync(p);
    if (!st.isFile() || !VIDEO_EXT.test(p)) throw new Error('Bukan file video.');
    if (st.size > MAX_BYTES) throw new Error(`File ${(st.size / 1048576).toFixed(0)} MB melebihi batas 50 MB Telegram — pilih resolusi lebih rendah.`);
    const mb = (st.size / 1048576).toFixed(1);
    emit(0, 'upload');
    await say(`⏳ Sedang mengirim video${total > 1 ? ` (${index + 1}/${total})` : ''}…\n“${title}” · ${mb} MB\nMohon tunggu, ini bukan error.`);
    const meta = probeMp4(p);
    const fields = { chat_id: s.chatId, caption: trim(f.caption, 1000), supports_streaming: 'true' };
    if (meta) { fields.width = meta.width; fields.height = meta.height; if (meta.duration) fields.duration = meta.duration; }
    let lastPct = -1, lastEdit = 0;
    const r = await uploadWithRetry(s.token, fields, p, name, (frac) => {
      const pct = Math.min(99, Math.floor(frac * 100));
      if (pct === lastPct) return;
      lastPct = pct; emit(pct, 'upload');
      const now = Date.now();
      if (now - lastEdit > 2500 && pct < 99) { lastEdit = now; say(`⏳ Mengirim video${total > 1 ? ` (${index + 1}/${total})` : ''}… ${pct}%\n“${title}” · ${mb} MB`); }
    }, (attemptNo, err) => { lastPct = -1; emit(0, 'retry'); say(`⏳ Koneksi sempat terputus, mencoba lagi (${attemptNo}/3)…
“${title}”`); });
    if (!(r.json && r.json.ok)) {
      const d = (r.json && r.json.description) || `HTTP ${r.status}`;
      throw new Error(/too large/i.test(d) ? 'File melebihi batas 50 MB Telegram.' : `Telegram menolak (${r.status}): ${d}`);
    }
    emit(100, 'done');
    if (statusId) { try { await call(s.token, 'deleteMessage', { chat_id: s.chatId, message_id: statusId }); } catch { /* already gone */ } }
    return { path: p, ok: true };
  } catch (e) {
    const msg = e && e.code === 'ENOENT' ? 'File video tidak ditemukan.' : (e && e.message ? e.message : String(e));
    emit(0, 'error');
    if (statusId) await say(`❌ Gagal mengirim “${title}”\n${msg}`);
    return { path: p, ok: false, error: msg };
  }
}

// files: [{ id, path, caption }] → one result per file, in order. A failure never stops the others.
ipcMain.handle('telegram:send', async (event, payload) => {
  const s = readStore();
  if (!s.token || !s.chatId) return { ok: false, error: 'Bot Telegram belum diatur.', results: [] };
  const files = Array.isArray(payload && payload.files) ? payload.files.slice(0, 50) : [];
  const results = [];
  for (let i = 0; i < files.length; i++) results.push(await sendOne(event, s, files[i] || {}, i, files.length));
  return { ok: results.every((r) => r.ok), results };
});
