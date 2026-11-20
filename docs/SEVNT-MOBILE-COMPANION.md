# SEVNT MOBILE COMPANION
**Status:** Rancangan Arsitektur + Implementasi Foundation
**Tanggal:** 2026-11-08

---

## OVERVIEW

HP Android/iOS mengakses SEVNT melalui browser. Laptop tetap melakukan semua processing.

```
HP (Browser)
    │  HTTPS / WSS
    │
    ▼
[MODE 1: LAN]  → langsung ke IP lokal laptop
[MODE 2: Tunnel] → melalui relay/tunnel ke laptop
    │
    ▼
SEVNT Mobile Gateway (di laptop)
    │
    ├── Authentication (session token)
    ├── Project API
    ├── Preview API
    ├── Control API
    └── WebSocket (real-time status)
```

---

## USER FLOW

```
Buka SEVNT Desktop
    │
    ▼
Klik "Connect Mobile"
    │
    ▼
SEVNT cek lisensi (companion slot tersedia?)
    │
    ├── Slot penuh → tampilkan: "HP sudah terdaftar. Unpair dulu?"
    │
    └── Slot tersedia atau sudah paired
            │
            ▼
        Jalankan Local Backend (jika belum jalan)
        Buat pairing session
        Deteksi mode jaringan (LAN/Remote)
            │
            ├── [LAN] Generate URL: http://192.168.x.x:SEVNT_PORT/pair?token=xxx
            │
            └── [Remote] Start tunnel → dapatkan HTTPS URL unik
                    │
                    ▼
            Tampilkan QR Code + URL
            Tunggu HP scan
                    │
                    ▼
            HP buka URL → pair screen
            User konfirmasi di laptop
                    │
                    ▼
            Companion registered ke License API
            Session token dikirim ke HP
            Mobile UI aktif
```

---

## NETWORK MODES

### Mode 1: LAN (Local Network)

Kondisi: Laptop dan HP di jaringan Wi-Fi yang sama.

```
Laptop: jalankan HTTP server di port SEVNT_MOBILE_PORT (default: 7474)
URL: http://<laptop-ip>:7474
```

Auto-detection: cek apakah HP bisa reach laptop via LAN sebelum menawarkan mode ini.

Kelebihan:
- Tidak butuh internet
- Latensi rendah
- Tidak ada biaya provider
- Privat total

Keterbatasan:
- Tidak berfungsi di jaringan berbeda (HP pakai data seluler)

### Mode 2: Remote Tunnel

Kondisi: HP dan laptop di jaringan berbeda.

Provider yang dievaluasi:

| Provider | Biaya | Batas | Windows | macOS | Catatan |
|----------|-------|-------|---------|-------|---------|
| Cloudflare Quick Tunnels | Gratis | Tidak terbatas (bandwith) | ✅ | ✅ | URL random per sesi, tidak perlu akun |
| Tailscale Funnel | Gratis (free tier) | 3 funnel endpoints | ✅ | ✅ | Perlu akun Tailscale |
| Custom relay (SEVNT) | Biaya server | Tidak terbatas | ✅ | ✅ | Kontrol penuh, butuh infra |
| ngrok | Free: 1 tunnel, random URL | Terbatas | ✅ | ✅ | Perlu akun |

**Rekomendasi untuk MVP:** Cloudflare Quick Tunnels — tidak perlu akun, gratis, CLI tersedia untuk Windows/macOS.

**Long-term:** Custom relay SEVNT untuk independence penuh.

---

## IMPLEMENTASI FONDASI

### File yang dibuat:

```
src/mobile/
├── mobile-gateway.js       — HTTP server untuk mobile interface
├── session-manager.js      — Pairing token + session management
├── pairing-manager.js      — QR code + pairing flow
├── tunnel-adapter.js       — Abstraksi provider tunnel (Cloudflare/custom)
├── lan-detector.js         — Deteksi LAN mode
└── mobile-routes.js        — API routes untuk HP
```

---

## PAIRING PROCESS DETAIL

```
Laptop                              HP
  │                                  │
  │  1. Buat pairing_token (random)   │
  │  2. Set expired: 5 menit          │
  │  3. Buat URL: .../pair?t=TOKEN    │
  │  4. Tampilkan QR Code             │
  │                                  │
  │         ← User scan QR ─────────│
  │                                  │
  │  5. HP GET /pair?t=TOKEN          │
  │  6. Laptop tampilkan konfirmasi   │
  │                                  │
  │      ← User klik "Allow" ────────│
  │                                  │
  │  7. POST /license/pair-companion  │
  │     (ke License API Seventy)      │
  │                                  │
  │  8. Companion registered          │
  │  9. Buat session_token (JWT)      │
  │  10. Set session TTL (24 jam)     │
  │                                  │
  │         → session_token ─────────│
  │                                  │
  │  11. HP simpan session_token      │
  │  12. Mobile UI aktif              │
```

---

## MOBILE SESSION SECURITY

| Aspek | Implementasi |
|-------|-------------|
| Pairing token | 32-byte random hex, 5 menit expired |
| Session token | JWT RS256, 24 jam, rotation setiap request |
| Transport | HTTPS wajib (remote), HTTP allowed (LAN dengan warning) |
| Authorization | Bearer token di setiap request |
| Rate limiting | 10 req/detik per IP |
| Origin | Validasi bahwa request dari companion device yang terdaftar |
| WebSocket | WSS (remote), WS (LAN) dengan auth handshake |
| Revoke | Laptop bisa disconnect paksa |
| Filesystem | HP hanya akses project SEVNT, bukan filesystem laptop |

---

## MOBILE UI FEATURES

| Fitur | Priority |
|-------|----------|
| Connection Status | P0 |
| Project List | P0 |
| Video Preview (9:16) | P0 |
| Processing Progress | P0 |
| Clip Selection | P1 |
| Transcript Viewer | P1 |
| Transcript Editor | P1 |
| Render Progress | P1 |
| Export Status | P1 |
| Disconnect | P0 |
| Device Pairing Status | P0 |
| Play/Pause | P1 |

---

## STATUS

- [x] Arsitektur: **SELESAI** (dokumen ini)
- [x] Foundation files: **DIBUAT** (src/mobile/)
- [ ] Cloudflare tunnel integration: **MENUNGGU** evaluasi biaya/terms
- [ ] License API companion endpoint: **MENUNGGU** server
- [ ] Mobile UI: **FOUNDATION DIBUAT**
- [ ] Testing: **BELUM**
