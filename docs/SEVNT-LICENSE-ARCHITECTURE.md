# SEVNT LICENSE ARCHITECTURE
**Status:** Rancangan Arsitektur (Phase 2)
**Tanggal:** 2026-11-08

---

## OVERVIEW

Sistem lisensi SEVNT dibangun sepenuhnya oleh Seventy, independen dari pihak manapun.

**Flow:**
```
SEVNT Desktop App
    │
    ├── LicenseManager (lokal)
    │       ├── loadCache() — baca cache terenkripsi dari userData
    │       ├── activate(email, key) — kirim ke server
    │       ├── validateOnline(cache) — revalidasi berkala
    │       ├── checkOnStartup() — cek saat app buka
    │       ├── deactivate() — hapus cache lokal
    │       └── revalidateNow() — paksa revalidasi
    │
    └── SEVNT License API (server Seventy)
            │
            ├── POST /license/activate
            ├── POST /license/validate
            ├── POST /license/deactivate
            └── Database (PostgreSQL)
```

---

## INTERFACE: LicenseManager

```javascript
// src/license/LicenseManager.js (SEVNT)
class LicenseManager {
  // Aktifkan lisensi dengan email + license key
  async activate(email, licenseKey)
  // → { ok: true } | { ok: false, error: string }

  // Cek saat startup (online + offline grace)
  async checkOnStartup()
  // → { status: 'valid' | 'invalid' | 'expired' | 'offline_grace' | 'too_long_offline' }

  // Revalidasi paksa (dari menu Settings)
  async revalidateNow()
  // → { status: 'valid' | 'invalid' }

  // Ambil data lisensi aktif
  getCurrentLicense()
  // → { email, licenseKey, machineId } | null

  // Deaktivasi (hapus cache)
  deactivate()
}
```

---

## API CONTRACT: SEVNT License API

### Endpoint Base
```
https://api.sevntstudio.com/license      (placeholder — ganti dengan domain resmi)
```

### POST /license/activate
```json
Request:
{
  "action": "activate",
  "email": "user@example.com",
  "license_key": "XXXX-XXXX-XXXX-XXXX",
  "machine_id": "<sha256 hash>",
  "nonce": "<16-byte hex>",
  "shared_secret": "<hmac dari shared secret>"
}

Response (success):
{
  "ok": true,
  "valid_until": "2027-01-01T00:00:00Z",
  "issued_at": "2026-11-08T00:00:00Z",
  "sig": "<Ed25519 signature base64>"
}

Response (error):
{
  "ok": false,
  "error": "license_not_found" | "machine_mismatch" | "license_expired" | "unknown_error"
}
```

### POST /license/validate
```json
Request:
{
  "action": "validate",
  "email": "user@example.com",
  "license_key": "XXXX-XXXX-XXXX-XXXX",
  "machine_id": "<sha256 hash>",
  "nonce": "<16-byte hex>",
  "shared_secret": "<hmac>"
}

Response: sama dengan /activate
```

### POST /license/deactivate
```json
Request:
{
  "action": "deactivate",
  "email": "user@example.com",
  "license_key": "XXXX-XXXX-XXXX-XXXX",
  "machine_id": "<sha256 hash>"
}

Response:
{
  "ok": true
}
```

---

## KEAMANAN

| Aturan | Detail |
|--------|--------|
| Private signing key | Hanya ada di server. TIDAK pernah di client/repo |
| Signature scheme | Ed25519 — server sign response, client verify |
| Cache encryption | AES-256-GCM, kunci diturunkan dari machine ID |
| Transport | HTTPS wajib (TLS 1.2+) |
| Shared secret | Disimpan via OS keychain (Electron safeStorage), TIDAK di source code |
| Revoke/reset | Server dapat revoke via database. Client bisa reset device |

---

## DEVICE IDENTIFICATION (machineId)

```javascript
// src/license/machineId.js (SEVNT)
// Kumpulkan hardware identifiers yang stabil:
//   - CPU serial (via node-machine-id atau native)
//   - Disk serial
//   - MAC address (pertama yang non-virtual)
// Hash dengan SHA256 → machine_id string
// Sediakan getLegacyMachineId() untuk backward compat jika ada perubahan algo
```

---

## OFFLINE GRACE PERIOD

```
App buka → loadCache() → ada cache valid?
    │
    ├─ Ya → cek last_validated_at
    │         │
    │         ├─ < REVALIDATE_INTERVAL (default: 3 hari) → { status: 'valid' }
    │         │
    │         └─ ≥ REVALIDATE_INTERVAL → validateOnline()
    │                   │
    │                   ├─ Berhasil → { status: 'valid' }
    │                   │
    │                   └─ Gagal (network error) → cek last_validated_at
    │                             │
    │                             ├─ < OFFLINE_GRACE (default: 7 hari) → { status: 'valid', offline: true }
    │                             │
    │                             └─ ≥ OFFLINE_GRACE → { status: 'too_long_offline' }
    │
    └─ Tidak → { status: 'invalid' }
```

---

## MOCK IMPLEMENTATION (Untuk Pengujian Lokal)

```javascript
// src/license/__mocks__/LicenseManager.mock.js
// Digunakan HANYA untuk testing — bukan production

class MockLicenseManager {
  async activate(email, key) {
    if (key === 'VALID-TEST-KEY-0001') return { ok: true };
    return { ok: false, error: 'license_not_found' };
  }
  async checkOnStartup() { return { status: 'valid', cache: { email: 'test@sevnt.dev' } }; }
  async revalidateNow() { return { status: 'valid' }; }
  getCurrentLicense() { return { email: 'test@sevnt.dev', licenseKey: 'VALID-TEST-KEY-0001' }; }
  deactivate() {}
}
```

---

## KEBUTUHAN INFRASTRUKTUR

Sebelum implementasi production:

- [ ] Domain server SEVNT (API endpoint)
- [ ] Generate Ed25519 key pair (server-side):
  ```bash
  openssl genpkey -algorithm ed25519 -out sevnt-license-private.pem
  openssl pkey -in sevnt-license-private.pem -pubout -out sevnt-license-public.pem
  ```
- [ ] Database license (tabel: licenses, activations, devices)
- [ ] Distribusikan public key ke dalam app (hardcoded, sama seperti pattern SOCL)

---

## STATUS

- [ ] Rancangan interface: **SELESAI** (dokumen ini)
- [ ] Mock implementation: **BELUM**
- [ ] Server implementation: **MENUNGGU** domain + infrastruktur
- [ ] Testing: **BELUM**
- [ ] Integrasi ke app: **BELUM** (menunggu server ready)
