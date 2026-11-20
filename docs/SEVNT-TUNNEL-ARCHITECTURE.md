# SEVNT TUNNEL ARCHITECTURE
**Status:** Rancangan Arsitektur
**Tanggal:** 2026-11-08

---

## OVERVIEW

Tunnel digunakan agar HP bisa mengakses SEVNT di laptop dari jaringan berbeda (HP pakai data seluler, laptop di Wi-Fi berbeda, dll).

**Tujuan:**
- HP buka URL HTTPS → terhubung ke SEVNT di laptop
- User tidak perlu konfigurasi DNS, port forward, atau domain
- URL dihasilkan otomatis saat sesi dimulai
- Koneksi aman, tidak ada akses bebas ke filesystem laptop

---

## EVALUASI PROVIDER

### 1. Cloudflare Quick Tunnels

```bash
# Tanpa akun, langsung jalan
cloudflared tunnel --url http://localhost:7474
# Output: https://random-name.trycloudflare.com
```

| Aspek | Detail |
|-------|--------|
| Biaya | Gratis |
| Akun | Tidak perlu |
| URL | Random per sesi (berubah setiap start) |
| Bandwidth | Unlimited (fair use) |
| Latensi | Rendah (Cloudflare edge) |
| Windows | ✅ binary cloudflared tersedia |
| macOS | ✅ brew install cloudflared |
| Privacy | Cloudflare bisa lihat traffic (HTTPS di edge) |
| Terms | Quick tunnels untuk dev/testing, production perlu akun |

**Status: REKOMENDASI MVP**

### 2. Tailscale Funnel

```bash
tailscale funnel 7474
# Output: https://hostname.tailnet.ts.net:7474
```

| Aspek | Detail |
|-------|--------|
| Biaya | Free tier: 3 device, 3 funnel endpoints |
| Akun | Perlu akun Tailscale |
| URL | Stabil (berdasarkan hostname) |
| Bandwidth | 100 GB/bulan free |
| Windows | ✅ |
| macOS | ✅ |
| Privacy | Tailscale tidak melihat konten (end-to-end encrypted) |

**Status: ALTERNATIF BAGUS — lebih privat dari Cloudflare**

### 3. Custom SEVNT Relay

```
HP → WSS → relay.sevntstudio.com → WSS → SEVNT Desktop
```

| Aspek | Detail |
|-------|--------|
| Biaya | Biaya server (~$5-20/bulan VPS) |
| Akun | Terintegrasi dengan akun SEVNT |
| URL | Stabil dan branded (sevntstudio.com) |
| Bandwidth | Sesuai server |
| Privacy | Seventy kontrol penuh |
| Kontrol | Bisa revoke tunnel per lisensi |

**Status: TARGET LONG-TERM — beri kontrol penuh ke Seventy**

### 4. ngrok

| Aspek | Detail |
|-------|--------|
| Biaya | Free: 1 static domain, 1 agent |
| Akun | Perlu akun ngrok |
| URL | Random atau static (perlu akun berbayar untuk custom) |

**Status: TIDAK DIREKOMENDASIKAN** — perlu akun, lebih terbatas dari Cloudflare Quick Tunnels

---

## ARSITEKTUR CLOUDFLARE QUICK TUNNELS (MVP)

```
cloudflared (binary)
    │
    ├── Download: github.com/cloudflare/cloudflared/releases
    ├── Simpan: userData/tunnel-tools/cloudflared.exe
    ├── Verifikasi: SHA256 dari manifest resmi
    └── Jalankan: cloudflared tunnel --url http://localhost:7474
            │
            └── Parse stdout untuk URL tunnel
```

### Implementasi di tunnel-adapter.js:

```javascript
class CloudflareQuickTunnel {
  async start(localPort) {
    const binary = await this.ensureBinary();
    this.proc = spawn(binary, ['tunnel', '--url', `http://localhost:${localPort}`]);
    
    return new Promise((resolve, reject) => {
      this.proc.stderr.on('data', (data) => {
        const match = data.toString().match(/https:\/\/[^\s]+\.trycloudflare\.com/);
        if (match) resolve({ url: match[0], provider: 'cloudflare' });
      });
      setTimeout(() => reject(new Error('Tunnel timeout')), 15000);
    });
  }

  async stop() {
    if (this.proc) this.proc.kill();
  }
}
```

---

## KEAMANAN TUNNEL

### Prinsip utama:
1. **Tunnel bukan akses bebas ke laptop** — hanya port SEVNT Mobile Gateway yang di-expose
2. **Semua request diautentikasi** — tanpa session token yang valid, request ditolak
3. **Token tidak permanen di URL** — URL pairing berisi token sementara (5 menit)
4. **Tidak ada akses filesystem** — mobile gateway hanya expose API SEVNT, bukan filesystem

### Restricted access via Mobile Gateway:
```
Tunnel → localhost:7474 (Mobile Gateway)
    │
    ├── POST /api/pair?t=TOKEN    — hanya valid 5 menit
    ├── GET  /api/projects        — perlu session token
    ├── GET  /api/preview/:id     — perlu session token
    ├── WS   /ws                  — perlu auth handshake
    │
    └── SEMUA endpoint lain → 404
```

### Yang TIDAK boleh di-expose via tunnel:
- Port Electron IPC
- File system access
- Admin endpoints
- Database langsung

---

## LIFECYCLE TUNNEL

```
User klik "Connect Mobile"
    │
    ▼
Cek apakah cloudflared binary ada
    ├── Tidak ada → download otomatis (dengan progress)
    └── Ada → lanjut
            │
            ▼
        Start Mobile Gateway (localhost:7474)
            │
            ▼
        Deteksi mode (LAN / Remote)
            ├── LAN tersedia → gunakan LAN URL
            └── Minta remote → start cloudflared
                    │
                    ▼
                Tunggu URL dari stdout (max 15 detik)
                    │
                    ▼
                Buat pairing URL: <tunnel-url>/pair?t=TOKEN
                Tampilkan QR Code
                    │
                    ▼
                HP scan → pairing flow
                    │
                    ▼
                Tunnel tetap aktif selama sesi HP aktif
                    │
                    ▼
                User disconnect → kill cloudflared process
```

---

## BINARY DISTRIBUTION CLOUDFLARED

SEVNT menyertakan cloudflared sebagai optional dependency — download on demand, bukan bundle langsung.

```json
{
  "cloudflared": {
    "version": "2024.x.x",
    "source": "https://github.com/cloudflare/cloudflared/releases",
    "license": "Apache 2.0",
    "bundled": false,
    "download_on_demand": true,
    "verify": "sha256"
  }
}
```

**Alasan tidak bundle:** ukuran binary ~20MB, hanya dibutuhkan oleh user yang memakai mode Remote.

---

## CUSTOM RELAY (RENCANA MASA DEPAN)

Arsitektur WebSocket relay sederhana:

```
HP (browser) ←→ WSS relay.sevntstudio.com ←→ SEVNT Desktop
```

Protocol:
1. Desktop SEVNT connect ke relay dengan `device_token` (dari license)
2. HP connect ke relay dengan `session_token` (dari pairing)
3. Relay hanya forward message — tidak decrypt konten
4. End-to-end authenticated dengan tokens

Keuntungan:
- URL stabil per lisensi
- Relay bisa revoke tunnel jika lisensi expired
- Tidak bergantung pada provider pihak ketiga
- Branding: `connect.sevntstudio.com`

---

## STATUS

- [x] Arsitektur: **SELESAI** (dokumen ini)
- [ ] Cloudflare binary download: **MENUNGGU** implementasi
- [ ] Custom relay: **MENUNGGU** server infrastructure
- [ ] Testing: **BELUM**
