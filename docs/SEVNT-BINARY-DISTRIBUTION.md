# SEVNT BINARY DISTRIBUTION
**Status:** Rancangan Distribusi Binary
**Tanggal:** 2026-11-08

---

## OVERVIEW

SEVNT menggunakan beberapa binary eksternal yang perlu diunduh atau dibundle. Setiap binary harus dievaluasi hak distribusinya sebelum digunakan.

---

## INVENTARIS BINARY

### 1. Whisper.cpp (Speech-to-Text)

| Aspek | Detail |
|-------|--------|
| Repo | github.com/ggml-org/whisper.cpp |
| Lisensi | MIT |
| Izin distribusi | ✅ Bebas digunakan, dikompilasi, didistribusikan |
| Binary sumber | Dikompilasi dari source, atau download dari releases repo SEVNT sendiri |
| Bundled | ❌ Download on demand ke userData |
| Hash verify | ✅ SHA256 wajib |

**Catatan:** Binary whisper.cpp perlu dikompilasi sendiri atau digunakan build yang sudah ada. SOCL menggunakan build dari repo `cultivatestd-lang` — SEVNT perlu build sendiri atau host di repo sendiri.

**Action required:** Setup GitHub Actions untuk build whisper.cpp untuk Windows (x64) dan macOS (arm64, x64), host di `SEVNT-ORG/sevnt-releases`.

---

### 2. FFmpeg + FFprobe

| Aspek | Detail |
|-------|--------|
| Lisensi | LGPL 2.1+ (most codecs) atau GPL (dengan libx264, dll) |
| Paket npm | `ffmpeg-static` (MIT wrapper, includes LGPL FFmpeg build) |
| Izin distribusi | ✅ ffmpeg-static sudah handle — bundled dalam package |
| Bundled | ✅ Via npm package (otomatis saat `npm install`) |
| Hash verify | Dihandle npm integrity |

**Status: AMAN** — ffmpeg-static sudah dipakai SOCL, lisensi LGPL membolehkan distribusi dengan persyaratan.

**Requirement LGPL compliance:**
- Sertakan copyright notice FFmpeg di distribusi
- Link dinamis (ffmpeg-static sudah handle ini)
- Tidak perlu source code karena LGPL (bukan GPL)

---

### 3. yt-dlp

| Aspek | Detail |
|-------|--------|
| Repo | github.com/yt-dlp/yt-dlp |
| Lisensi | Unlicense (domain publik) |
| Izin distribusi | ✅ Bebas digunakan dan didistribusikan |
| Bundled | ✅ atau Download on demand |
| Hash verify | ✅ SHA256 wajib |

**Status: AMAN** — Unlicense = tidak ada pembatasan penggunaan atau distribusi.

---

### 4. Silero VAD Model

| Aspek | Detail |
|-------|--------|
| Repo | huggingface.co/ggml-org/whisper-vad |
| Lisensi | Apache 2.0 |
| Izin distribusi | ✅ Bebas digunakan dan didistribusikan |
| Format | GGML format |
| Bundled | ❌ Download on demand ke userData |
| Sumber | HuggingFace (publik) |

**Status: AMAN** — Apache 2.0 membolehkan penggunaan komersial.

---

### 5. Whisper GGML Models (speech-to-text models)

| Model | Lisensi | Sumber |
|-------|---------|--------|
| ggml-tiny.bin | MIT | huggingface.co/ggerganov/whisper.cpp |
| ggml-base.bin | MIT | huggingface.co/ggerganov/whisper.cpp |
| ggml-small.bin | MIT | huggingface.co/ggerganov/whisper.cpp |

**Status: AMAN** — MIT license dari OpenAI Whisper model weights.

---

### 6. Face Tracker Binary

| Aspek | Detail |
|-------|--------|
| Sumber SOCL | github.com/cultivatestd-lang/socl-visuals-releases |
| Lisensi | **TIDAK DIKETAHUI** — perlu investigasi |
| Izin distribusi | **TIDAK BOLEH DIASUMSI** |

**⚠️ ACTION REQUIRED:**
- Identifikasi teknologi yang digunakan (MediaPipe? OpenCV? Custom?)
- Jika proprietary milik SOCL/cultivatestd-lang → SEVNT TIDAK BOLEH gunakan binary ini
- Harus cari alternatif open source atau buat sendiri
- Alternatif kandidat:
  - MediaPipe Face Detection (Apache 2.0)
  - OpenCV DNN face detection (Apache 2.0)
  - InsightFace (MIT)

---

### 7. Context Model (TF-IDF)

| Aspek | Detail |
|-------|--------|
| Sumber SOCL | github.com/cultivatestd-lang/socl-visuals-releases |
| Lisensi | **TIDAK DIKETAHUI** |
| Izin distribusi | **TIDAK BOLEH DIASUMSI** |

**⚠️ ACTION REQUIRED:**
- Ini kemungkinan model/data TF-IDF untuk kontekstual processing
- Jika model data, bisa dibuat ulang dengan dataset publik
- Jika binary proprietary → rebuild dari scratch
- Alternatif: gunakan library TF-IDF open source (natural, compromise) tanpa model binary

---

### 8. cloudflared (Cloudflare Tunnel CLI)

| Aspek | Detail |
|-------|--------|
| Repo | github.com/cloudflare/cloudflared |
| Lisensi | Apache 2.0 |
| Izin distribusi | ✅ Apache 2.0 membolehkan redistribusi |
| Bundled | ❌ Download on demand — ukuran ~20MB |
| Hash verify | ✅ SHA256 wajib, verify dari GitHub release |

**Status: AMAN** — Apache 2.0.

---

## BINARY MANIFEST FORMAT (SEVNT)

```json
{
  "whisper": {
    "version": "1.9.1",
    "source": "github",
    "repo": "SEVNT-ORG/sevnt-releases",
    "tag": "whisper-cli-v1.9.1",
    "files": {
      "win32-x64": {
        "filename": "whisper-win-x64.exe",
        "sha256": "<hash>",
        "url": "https://github.com/SEVNT-ORG/sevnt-releases/releases/download/whisper-cli-v1.9.1/whisper-win-x64.exe"
      },
      "darwin-arm64": {
        "filename": "whisper-mac-arm64",
        "sha256": "<hash>",
        "url": "..."
      },
      "darwin-x64": {
        "filename": "whisper-mac-x64",
        "sha256": "<hash>",
        "url": "..."
      }
    }
  },
  "vad": {
    "version": "1.0",
    "source": "huggingface",
    "repo": "ggml-org/whisper-vad",
    "files": {
      "all": {
        "filename": "ggml-silero-v5.1.2.bin",
        "sha256": "<hash>",
        "url": "https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin"
      }
    }
  }
}
```

---

## HASH VERIFICATION

Semua binary WAJIB diverifikasi SHA256 sebelum dieksekusi:

```javascript
const crypto = require('crypto');
const fs = require('fs');

async function verifySha256(filePath, expectedHash) {
  const data = await fs.promises.readFile(filePath);
  const actual = crypto.createHash('sha256').update(data).digest('hex');
  if (actual !== expectedHash.toLowerCase()) {
    throw new Error(`Hash mismatch for ${filePath}: expected ${expectedHash}, got ${actual}`);
  }
  return true;
}
```

---

## TABEL RINGKASAN

| Binary | Lisensi | Distribusi | Action |
|--------|---------|------------|--------|
| Whisper.cpp | MIT | ✅ Bebas | Build sendiri, host di SEVNT repo |
| FFmpeg | LGPL 2.1 | ✅ via ffmpeg-static | Sudah via npm |
| FFprobe | LGPL 2.1 | ✅ via ffmpeg-static | Sudah via npm |
| yt-dlp | Unlicense | ✅ Bebas | Bundle atau download |
| Silero VAD | Apache 2.0 | ✅ Bebas | Download dari HuggingFace |
| Whisper models | MIT | ✅ Bebas | Download dari HuggingFace |
| Face Tracker | ❓ Unknown | ⚠️ JANGAN pakai SOCL binary | Cari alternatif open source |
| Context Model | ❓ Unknown | ⚠️ JANGAN pakai SOCL binary | Rebuild atau cari alternatif |
| cloudflared | Apache 2.0 | ✅ Bebas | Download on demand |

---

## STATUS

- [x] Inventaris binary: **SELESAI** (dokumen ini)
- [ ] Face Tracker — identifikasi lisensi: **PERLU INVESTIGASI**
- [ ] Context Model — identifikasi lisensi: **PERLU INVESTIGASI**
- [ ] GitHub Actions untuk build whisper.cpp: **MENUNGGU** repo SEVNT
- [ ] Binary manifest SEVNT: **MENUNGGU** repo dan hash aktual
- [ ] Legal review lisensi: **DIREKOMENDASIKAN** sebelum distribusi publik
