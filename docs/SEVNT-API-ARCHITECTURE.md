# SEVNT API ARCHITECTURE
**Status:** Rancangan Arsitektur (Phase 2)
**Tanggal:** 2026-11-08

---

## OVERVIEW: KLASIFIKASI LAYANAN EKSTERNAL

Setiap koneksi eksternal SEVNT diklasifikasikan ke dalam kategori berikut:

---

## KATEGORI 1: WAJIB SERVER SEVNT

Layanan yang HARUS berjalan di server milik Seventy:

| Layanan | Fungsi | Status |
|---------|--------|--------|
| **License API** | Aktivasi, validasi, deaktivasi lisensi | Menunggu server |
| **Preset Catalog API** | Distribusi preset baru tanpa rilis app | Menunggu domain |
| **Update Manifest** | Informasi versi terbaru + download URL | Menunggu repo |

**Endpoint target:**
```
https://api.sevntstudio.com/license        — License API
https://catalog.sevntstudio.com/v1/catalog — Preset Catalog
https://releases.sevntstudio.com/          — Update + Binary releases
```

---

## KATEGORI 2: BISA DIJALANKAN LOKAL

Layanan yang berjalan di mesin user, tidak perlu server:

| Layanan | File | Catatan |
|---------|------|---------|
| **Whisper.cpp (transcription)** | `whisper-bundle.js` | Binary didownload ke userData. Jalan 100% offline setelah download |
| **FFmpeg / FFprobe** | `pipeline-inverse-v1.js` | Bundled dalam package, selalu lokal |
| **yt-dlp** | `pipeline-inverse-v1.js` | Bundled (embedded), selalu lokal |
| **Face Tracker** | `tracker-bundle.js` | Binary didownload ke userData |
| **Context Model (TF-IDF)** | `context-model/` | Model didownload ke userData |
| **VAD (Silero)** | `whisper-bundle.js` | Model kecil, didownload ke userData |
| **OS Keychain** | `secrets.js` | Native OS, tidak ada server |

**ATURAN PENTING:**
> Jangan ubah pipeline Whisper (audio splitting, word-level timestamp, VAD). Yang perlu diganti hanya URL binary di `whisper-manifest.json`.

---

## KATEGORI 3: PROVIDER EKSTERNAL DENGAN KEY SENDIRI

Layanan yang tetap menggunakan provider pihak ketiga, tapi dengan konfigurasi milik user (BYOK):

| Layanan | Provider | Endpoint | Catatan |
|---------|----------|----------|---------|
| **LLM hook title** | Groq | `api.groq.com` | BYOK — user bawa key sendiri |
| **LLM hook title** | Anthropic | `api.anthropic.com` | BYOK |
| **LLM hook title** | OpenAI | `api.openai.com` | BYOK |
| **LLM hook title** | OpenRouter | `openrouter.ai` | BYOK (akses banyak model) |
| **LLM hook title** | Google Gemini | `generativelanguage.googleapis.com` | BYOK |
| **Cloud Whisper** | Groq | `api.groq.com` | BYOK, opsional (ada local Whisper) |

**Strategi:** SEVNT tidak perlu server AI sendiri untuk MVP. Pertahankan BYOK model. Jika nanti SEVNT ingin menyediakan AI processing sendiri, bisa ditambahkan sebagai option baru tanpa menghapus BYOK.

---

## KATEGORI 4: TIDAK DIPERLUKAN

Layanan yang tidak perlu ada di SEVNT atau bisa dihapus:

| Layanan | Alasan |
|---------|--------|
| `ai.sumopod.com` | Unknown/unofficial provider — evaluasi apakah perlu dipertahankan |
| `lynk.id` (purchase URL SOCL) | Ganti dengan payment platform Seventy sendiri |

---

## KATEGORI 5: BELUM DIKETAHUI / PERLU INVESTIGASI LANJUT

| Layanan | Lokasi | Status |
|---------|--------|--------|
| **main.js full content** | `src/main.js` | Tidak terbaca penuh (terlalu besar). Mungkin ada koneksi eksternal lain yang belum terdeteksi |
| **renderer.js** | `src/renderer.js` | Belum diaudit |
| **audit.js** | `src/audit.js` | Belum dibaca — kemungkinan analytics/telemetry endpoint |
| **status-disclosure.js** | `src/status-disclosure.js` | Belum dibaca — kemungkinan ada URL status page |
| **track-plan.js / track-refine.js** | `src/*.js` | Belum dibaca |

---

## TARGET ARSITEKTUR SEVNT

```
SEVNT DESKTOP
│
├── LOCAL (always-on, no internet needed after install)
│   ├── Whisper.cpp binary
│   ├── GGML speech model
│   ├── Silero VAD model
│   ├── FFmpeg / FFprobe
│   ├── yt-dlp
│   ├── Face Tracker binary
│   └── Context Model (TF-IDF)
│
├── BYOK (user's own API keys, stored in OS keychain)
│   ├── Groq (LLM + Cloud Whisper)
│   ├── Anthropic Claude
│   ├── OpenAI
│   └── OpenRouter
│
├── SEVENTY CLOUD (required for license + catalog + updates)
│   ├── License API ............. api.sevntstudio.com/license
│   ├── Preset Catalog API ...... catalog.sevntstudio.com/v1/catalog
│   ├── Update Manifest ......... releases.sevntstudio.com/update-manifest.json
│   └── Binary releases ......... github.com/SEVNT-ORG/sevnt-releases
│
└── PUBLIC SERVICES (no account/key needed)
    ├── YouTube Innertube ........ youtube.com (caption fetch)
    └── HuggingFace .............. huggingface.co (Whisper model download)
```

---

## ENVIRONMENT CONFIGURATION

```javascript
// src/sevnt-config.js — PLACEHOLDER (isi saat domain resmi tersedia)
module.exports = {
  // License
  LICENSE_API_ENDPOINT: process.env.SEVNT_LICENSE_API
    || 'https://api.sevntstudio.com/license',          // PLACEHOLDER

  // Preset Catalog
  CATALOG_URL: process.env.SEVNT_CATALOG_URL
    || 'https://catalog.sevntstudio.com/v1/catalog',    // PLACEHOLDER
  CATALOG_FALLBACK: process.env.SEVNT_CATALOG_FALLBACK
    || 'https://sevnt-catalog.PLACEHOLDER.workers.dev/v1/catalog', // PLACEHOLDER

  // Update
  UPDATE_REPO: process.env.SEVNT_UPDATE_REPO
    || 'SEVNT-ORG/sevnt-releases',                     // PLACEHOLDER

  // App
  APP_NAME: 'SEVNT Studio',
  COMPANY: 'Seventy',
  OFFLINE_GRACE_DAYS: 7,
  REVALIDATE_INTERVAL_DAYS: 3,
};
```

**ATURAN:**
- Semua URL server menggunakan environment variable sebagai override
- Nilai default adalah placeholder — JANGAN deploy ke production sebelum domain resmi tersedia
- Jangan simpan credential atau API secret di source code

---

## CONTENT SECURITY POLICY (CSP) untuk SEVNT

Berdasarkan audit CSP di SOCL (`index.html`), CSP untuk SEVNT seharusnya:

```
connect-src 'self'
  https://api.sevntstudio.com
  https://catalog.sevntstudio.com
  https://api.groq.com
  https://api.anthropic.com
  https://api.openai.com
  https://openrouter.ai
  https://generativelanguage.googleapis.com;
```

Hapus dari CSP SOCL yang tidak perlu di SEVNT:
- `https://ai.sumopod.com` (evaluasi dulu apakah perlu)
- Domain milik SOCL

---

## PRIVASI PENGGUNA

| Data | Treatment |
|------|-----------|
| Video user | TIDAK dikirim ke server manapun tanpa persetujuan eksplisit |
| Transcript | Dikirim ke LLM provider HANYA jika user memilih cloud transcription/LLM |
| Email lisensi | Dikirim ke License API saat aktivasi/validasi |
| Machine ID | Hash SHA256 (tidak reversible ke hardware info asli) |
| API keys user | Disimpan di OS keychain, tidak pernah dikirim ke server SEVNT |

---

## STATUS INFRASTRUKTUR

| Komponen | Status |
|----------|--------|
| Domain `api.sevntstudio.com` | **MENUNGGU** keputusan domain |
| Domain `catalog.sevntstudio.com` | **MENUNGGU** |
| GitHub Org SEVNT | **MENUNGGU** |
| License database | **MENUNGGU** |
| Ed25519 key pairs | **MENUNGGU** |
| Cloudflare account SEVNT | **MENUNGGU** |
| Payment platform | **MENUNGGU** (ganti lynk.id) |
