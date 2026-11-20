# SEVNT MOBILE SECURITY
**Status:** Spesifikasi Keamanan
**Tanggal:** 2026-11-08

---

## PRINSIP KEAMANAN MOBILE

Sesuai aturan wajib dari Master Execution Prompt:

1. **Tunnel tidak boleh memberikan akses bebas ke laptop**
2. **Tidak ada akses bebas ke filesystem**
3. **Tidak ada akses ke endpoint administratif**
4. **Tidak ada token permanen di URL**
5. **Jangan mengekspos API internal tanpa autentikasi**

---

## MODEL ANCAMAN

| Ancaman | Risiko | Mitigasi |
|---------|--------|----------|
| Seseorang menemukan URL tunnel | Tinggi | Semua endpoint butuh auth token |
| Pairing token dicuri saat scan QR | Medium | Token expired dalam 5 menit, sekali pakai |
| Session token bocor | Medium | TTL 24 jam, rotation per request, dapat di-revoke |
| Man-in-the-middle di LAN | Medium | Warning di UI, upgrade ke HTTPS jika tersedia |
| Brute force session token | Rendah | Rate limit 10 req/detik, lockout setelah 20 gagal |
| Akses filesystem via mobile | Tinggi | Mobile Gateway hanya expose SEVNT API, bukan fs |
| Tunnel yang tidak dimatikan | Medium | Auto-kill saat app tutup atau HP disconnect |
| Token permanen di URL | Tinggi | Pairing token 5 menit, session token di header |

---

## PAIRING TOKEN

```
Properti:
- Format: 32-byte hex random (crypto.randomBytes(32).toString('hex'))
- Panjang: 64 karakter
- TTL: 5 menit sejak dibuat
- Sekali pakai: langsung invalidate setelah digunakan
- Tidak bisa di-reuse: setiap pairing buat token baru
- Tidak ada di URL produksi: hanya di /pair?t=TOKEN (sekali pakai)

Contoh: a3f8b2c9d4e1f7a0b5c2d9e6f3a0b7c4d1e8f5a2b9c6d3e0f7a4b1c8d5e2f9a6
```

---

## SESSION TOKEN

```
Format: JWT (JSON Web Token)
Algorithm: RS256 (RSA + SHA-256)
Payload:
  {
    "sub": "device_id",          // SHA256 machine fingerprint HP
    "lic": "license_key_hash",   // Lisensi yang terkait
    "role": "COMPANION_DEVICE",
    "iat": 1234567890,           // Issued at
    "exp": 1234654290,           // 24 jam dari issued
    "jti": "unique-id"           // Untuk revocation
  }

Signing key: Private key SEVNT di desktop app
Verification: Public key diketahui Mobile Gateway lokal

TTL: 24 jam
Rotation: Token baru dikirim di response header setiap request
Revocation: Laptop hapus key pair → semua token invalid

Penyimpanan di HP:
- sessionStorage browser (hilang saat browser tutup)
- BUKAN localStorage (agar tidak permanen di HP orang lain)
```

---

## TRANSPORT SECURITY

### Mode Remote (Tunnel)
```
HP → HTTPS → Cloudflare Edge → cloudflared → localhost:7474
     ✅ TLS 1.3 di-handle Cloudflare
     ✅ HSTS enforced
     ✅ Certificate valid (Cloudflare manage)
```

### Mode LAN
```
HP → HTTP → localhost:7474
     ⚠️ Tidak terenkripsi (di jaringan lokal)
     → UI menampilkan warning "Koneksi lokal tidak terenkripsi"
     → Tetap butuh session token (auth tetap ada)
     → Pertimbangkan self-signed cert untuk mLAN HTTPS di v2
```

---

## RATE LIMITING

```javascript
// Di mobile-gateway.js
const rateLimitMap = new Map(); // ip → { count, resetAt }

function rateLimit(req, res, next) {
  const ip = req.ip;
  const now = Date.now();
  const entry = rateLimitMap.get(ip) || { count: 0, resetAt: now + 1000 };
  
  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + 1000;
  }
  
  entry.count++;
  rateLimitMap.set(ip, entry);
  
  if (entry.count > 10) {
    return res.status(429).json({ error: 'rate_limit_exceeded' });
  }
  next();
}
```

---

## AUTENTIKASI REQUEST

Semua request ke Mobile Gateway (kecuali /pair) harus menyertakan:

```
Authorization: Bearer <session_token>
```

Validasi:
1. Token ada di header
2. JWT signature valid (verify dengan public key lokal)
3. Token belum expired
4. `lic` di token match dengan lisensi yang aktif di laptop
5. `sub` match dengan companion device yang terdaftar

---

## ENDPOINT YANG BOLEH DIAKSES HP

```
PUBLIC (tanpa auth):
  GET  /                     — mobile UI static files
  POST /api/pair             — pairing (butuh pairing token)
  GET  /api/health           — cek apakah server aktif

AUTHENTICATED:
  GET  /api/projects         — daftar project SEVNT
  GET  /api/project/:id      — detail project
  GET  /api/preview/:id      — preview video (stream)
  POST /api/project/:id/clip — pilih clip
  WS   /ws                   — realtime status

TIDAK BOLEH DIAKSES:
  /api/admin/*               — 404
  /api/license/*             — 404
  /api/files/*               — 404
  semua endpoint lain        — 404
```

---

## REVOCATION

Laptop bisa revoke semua sesi HP:

1. **Soft revoke**: hapus session token dari daftar valid → HP harus pair ulang
2. **Hard revoke**: unpair dari license API → companion slot kosong → HP tidak bisa pair tanpa license key
3. **Auto revoke**: saat laptop shutdown → kill tunnel + hapus active sessions

HP tidak bisa revoke laptop (hanya bisa disconnect dari sisi HP).

---

## AUDIT LOG (LOKAL)

Semua aksi mobile dicatat di audit log lokal (userData/audit.log):

```json
{"ts":"2026-11-08T10:00:00Z","event":"mobile_pair","device_id":"sha256...","ip":"192.168.1.5","result":"ok"}
{"ts":"2026-11-08T10:05:00Z","event":"mobile_request","path":"/api/projects","method":"GET","result":"ok"}
{"ts":"2026-11-08T10:10:00Z","event":"mobile_disconnect","device_id":"sha256...","reason":"user_disconnect"}
```

Log tidak dikirim ke server. Hanya untuk debugging lokal.

---

## STATUS

- [x] Spesifikasi keamanan: **SELESAI** (dokumen ini)
- [ ] Implementasi JWT: **MENUNGGU** implementasi mobile modules
- [ ] Testing penetrasi: **BELUM**
- [ ] Security review: **BELUM**
