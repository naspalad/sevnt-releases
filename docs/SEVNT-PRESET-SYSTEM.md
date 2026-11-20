# SEVNT PRESET SYSTEM
**Status:** Rancangan Arsitektur (Phase 2)
**Tanggal:** 2026-11-08

---

## OVERVIEW

Sistem katalog preset SEVNT memungkinkan Seventy mendistribusikan preset baru (hook, caption, video FX) ke semua user tanpa perlu rilis app baru.

**Flow:**
```
SEVNT Desktop App
    │
    ├── loadCached()   — langsung pakai preset dari userData cache (offline-first)
    │
    └── refresh()      — background fetch dari SEVNT Catalog API
            │
            ├── Verifikasi Ed25519 signature
            ├── Validasi schema
            ├── Cek versi (hanya update jika lebih baru)
            ├── Simpan ke cache (userData/sevnt-preset-catalog.json)
            └── Inject ke registry (HookPresets, KineticTitle, VideoFx)
```

---

## CATALOG SCHEMA

```json
{
  "version": 1,
  "hookPresets": [
    {
      "id": "clean_bold",
      "label": "Clean Bold",
      "textCase": "upper",
      "title": {
        "style": "white_clean",
        "fn": "Montserrat-Bold",
        "fs": 80,
        "anim": "pop",
        "layout": "auto"
      },
      "accent": {
        "target": "last",
        "color": "#FFDD00",
        "box": false
      }
    }
  ],
  "captionTemplates": [
    {
      "id": "cc_bold_yellow",
      "label": "Bold Yellow",
      "spec": {
        "font": "Montserrat-Bold",
        "px": 72,
        "color": "#FFFFFF",
        "current": { "color": "#FFDD00" }
      }
    }
  ],
  "videoFx": [
    {
      "id": "cut_cyan",
      "label": "Cyan Cutout",
      "kind": "cutout",
      "color": "#00FFFF"
    }
  ]
}
```

**Catatan:**
- `id` untuk hookPresets: lowercase, huruf/angka/underscore, 3-40 karakter
- `id` untuk captionTemplates: harus diawali `cc_`
- `id` untuk videoFx: harus diawali `cut_` (cutout) atau `duo_` (duotone)
- Semua font yang direferensi harus ada di bundle app

---

## ENVELOPE FORMAT (Signed Catalog)

```json
{
  "payload": "{\"version\":1,\"hookPresets\":[...]}",
  "sig": "<base64 Ed25519 signature>"
}
```

Catalog hanya diterima jika:
1. Signature valid (Ed25519, menggunakan SEVNT public key)
2. Schema valid (semua field sesuai spesifikasi)

---

## API CONTRACT: SEVNT Catalog API

### Endpoint
```
GET https://catalog.sevntstudio.com/v1/catalog     (placeholder — ganti domain resmi)
```
Fallback (jika ISP blokir):
```
GET https://sevnt-catalog.[worker].workers.dev/v1/catalog
```

**Catatan ISP:** Berdasarkan temuan di SOCL, beberapa ISP Indonesia (XL Axiata) memblok `*.workers.dev`. Gunakan custom domain sebagai primary URL.

### Response
```json
{
  "payload": "<json string>",
  "sig": "<base64 Ed25519 signature>"
}
```

---

## PUBLISH WORKFLOW (Seventy Internal)

```bash
# 1. Generate key pair (SEKALI SAJA, simpan private key aman)
openssl genpkey -algorithm ed25519 -out ~/.sevnt/catalog-ed25519.pem
openssl pkey -in ~/.sevnt/catalog-ed25519.pem -pubout -out sevnt-catalog-public.pem

# 2. Simpan public key ke app di: src/sevnt-preset-catalog-key.js
# module.exports = "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n";

# 3. Edit catalog: catalog/sevnt-catalog.json

# 4. Sign dan publish (script yang perlu dibuat):
node scripts/publish-catalog.js \
  --key ~/.sevnt/catalog-ed25519.pem \
  --catalog catalog/sevnt-catalog.json \
  --publish-url https://catalog.sevntstudio.com/v1/catalog
```

---

## INTERFACE: PresetCatalogProvider

```javascript
// src/sevnt-catalog-loader.js (SEVNT)
const CATALOG_URL = 'https://catalog.sevntstudio.com/v1/catalog';        // ganti saat domain tersedia
const CATALOG_FALLBACK = 'https://sevnt-catalog.PLACEHOLDER.workers.dev/v1/catalog';

module.exports = {
  loadCached(userData),   // Langsung pakai cache, inject ke registries
  refresh(userData, opts), // Background fetch + signature verify + schema validate
  current(),              // Catalog yang sedang aktif
};
```

---

## KATEGORI PRESET

Berdasarkan audit SOCL, preset yang bisa dikelola via remote catalog:

| Kategori | Deskripsi | Contoh |
|----------|-----------|--------|
| `hookPresets` | Style untuk judul/hook video | Font, warna, animasi, layout |
| `captionTemplates` | Style untuk subtitle/caption | Font, ukuran, warna kata aktif |
| `videoFx` | Efek warna untuk video | Cutout color, duotone |

**Tidak masuk catalog (tetap di app):**
- Template yang berisi kode (kinetic title animations, complex effects)
- Built-in presets (selalu menang jika ada konflik ID)

---

## ATURAN KEAMANAN

| Aturan | Detail |
|--------|--------|
| Private key | HANYA di mesin publisher Seventy, TIDAK pernah di repo atau server |
| Signature wajib | App menolak catalog tanpa signature valid |
| Schema strict | App menolak catalog dengan field unknown atau nilai invalid |
| Built-in menang | Remote preset tidak bisa override built-in preset |
| Tidak ada code execution | Remote catalog hanya berisi DATA (tidak ada script/code yang dieksekusi) |
| Cache versioning | App hanya update jika `version` remote lebih besar dari cache |

---

## FALLBACK BEHAVIOR

```
loadCached() → ada cache → inject preset dari cache
    │
    └─ tidak ada cache → pakai built-in preset saja (app tetap berjalan)

refresh() → error (network/signature/schema) → tetap pakai cache lama
    │
    └─ sukses, versi lebih baru → update cache + inject preset baru
```

---

## STATUS

- [ ] Schema definition: **SELESAI** (dokumen ini)
- [ ] API endpoint SEVNT: **MENUNGGU** domain + hosting
- [ ] Ed25519 key pair SEVNT: **MENUNGGU** (harus dibuat oleh Seventy)
- [ ] Public key di app: **MENUNGGU** key pair
- [ ] Publish script: **BELUM**
- [ ] Testing: **BELUM**
