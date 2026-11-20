# SEVNT LIFETIME LICENSE
**Status:** Spesifikasi Final
**Tanggal:** 2026-11-08

---

## MODEL BISNIS

**ONE TIME PAYMENT — LIFETIME LICENSE**

Pengguna membayar satu kali. Lisensi berlaku selamanya.

Tidak ada subscription untuk hak penggunaan aplikasi.

---

## ALOKASI PERANGKAT

| Slot | Role | Jumlah | Fungsi |
|------|------|--------|--------|
| 1 | `PRIMARY_DEVICE` | 1 | Laptop utama — semua rendering/processing |
| 2 | `COMPANION_DEVICE` | 1 | HP — remote interface via browser |

**Ketentuan:**
- Satu lisensi = maksimal 1 laptop aktif + 1 HP aktif
- HP BUKAN laptop kedua — hanya companion
- Dua laptop tidak boleh aktif dengan satu lisensi yang sama
- Pengguna dapat ganti HP (unpair → pair ulang)
- Pengguna dapat ganti laptop (transfer/reset)
- Mengganti perangkat tidak menghilangkan lisensi

---

## DATABASE SCHEMA

```sql
-- Tabel licenses
CREATE TABLE licenses (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  license_key_hash    VARCHAR(64) NOT NULL UNIQUE,  -- SHA256 dari license key
  owner_email         VARCHAR(255) NOT NULL,
  license_type        VARCHAR(20) NOT NULL DEFAULT 'lifetime',  -- 'lifetime'
  purchase_date       TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked             BOOLEAN NOT NULL DEFAULT FALSE,
  revoked_at          TIMESTAMPTZ,
  revoked_reason      TEXT
);

-- Tabel device_activations
CREATE TABLE device_activations (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  license_id          UUID NOT NULL REFERENCES licenses(id),
  device_id           VARCHAR(64) NOT NULL,         -- SHA256 machine fingerprint
  device_role         VARCHAR(20) NOT NULL,          -- 'PRIMARY_DEVICE' | 'COMPANION_DEVICE'
  device_status       VARCHAR(20) NOT NULL DEFAULT 'active',  -- 'active' | 'inactive' | 'transferred'
  activation_date     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_validation     TIMESTAMPTZ,
  deactivated_at      TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index
CREATE UNIQUE INDEX idx_license_active_primary
  ON device_activations(license_id)
  WHERE device_role = 'PRIMARY_DEVICE' AND device_status = 'active';

CREATE UNIQUE INDEX idx_license_active_companion
  ON device_activations(license_id)
  WHERE device_role = 'COMPANION_DEVICE' AND device_status = 'active';

-- Tabel validation_log (opsional, untuk audit)
CREATE TABLE validation_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  license_id  UUID REFERENCES licenses(id),
  device_id   VARCHAR(64),
  action      VARCHAR(30),   -- 'activate' | 'validate' | 'deactivate' | 'transfer'
  success     BOOLEAN,
  ip_address  INET,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

---

## LIFECYCLE LISENSI LIFETIME

```
PURCHASE
    │
    ▼
INACTIVE (license ada di DB, belum diaktifkan)
    │
    ▼ activate (PRIMARY_DEVICE)
ACTIVE — satu laptop terdaftar
    │
    ├── pair-companion → ACTIVE + COMPANION
    │
    ├── unpair-companion → ACTIVE (companion slot kosong)
    │
    ├── transfer-device → PRIMARY_DEVICE baru, lama dinonaktifkan
    │
    ├── validate → konfirmasi masih aktif, perbarui last_validation
    │
    └── revoke (admin) → REVOKED (permanen, tidak bisa aktif lagi)
```

---

## OFFLINE GRACE PERIOD

Lisensi lifetime tidak menjadi subscription karena offline.

| Kondisi | Behavior |
|---------|----------|
| Cache valid, belum 3 hari sejak validasi | Lanjut tanpa cek server |
| Cache valid, sudah > 3 hari | Cek server. Jika gagal → grace period |
| Grace period aktif (< 7 hari offline) | App berjalan, tampilkan peringatan |
| Grace period habis (> 7 hari offline) | App masih berjalan, tampilkan dialog koneksi |
| Cache tidak ada | Minta aktivasi |

**TIDAK BOLEH:**
- Menghapus project/data user karena offline
- Mengunci editing karena server unreachable
- Mengubah lisensi lifetime jadi subscription

---

## PEMBEDAAN: LIFETIME vs BIAYA LAYANAN CLOUD

| Aspek | Model |
|-------|-------|
| Hak penggunaan app | Lifetime — satu kali bayar |
| License validation server | Biaya operasional Seventy (transparan) |
| Mobile relay/tunnel (remote) | Mungkin ada biaya provider |
| AI cloud processing | BYOK (user bawa key sendiri) |
| Preset catalog delivery | Biaya CDN Seventy |

Jika ada layanan relay yang menimbulkan biaya, harus dikomunikasikan secara transparan kepada pengguna.

---

## ENDPOINT LICENSE API

```
POST /license/activate          — Aktifkan laptop
POST /license/validate          — Revalidasi
POST /license/deactivate        — Deaktivasi laptop
POST /license/pair-companion    — Daftarkan HP
POST /license/unpair-companion  — Hapus HP
POST /license/transfer-device   — Pindahkan ke laptop baru
GET  /license/status            — Status lisensi aktif
```

Semua endpoint memerlukan:
- HTTPS
- Shared secret (HMAC) atau JWT
- Nonce (anti-replay)
- Rate limiting

---

## STATUS

- [x] Spesifikasi bisnis: **SELESAI**
- [x] Database schema: **SELESAI**  
- [ ] Server implementation: **MENUNGGU** domain + infrastruktur
- [ ] Payment integration: **MENUNGGU** keputusan platform
- [ ] Testing: **MENUNGGU** server
