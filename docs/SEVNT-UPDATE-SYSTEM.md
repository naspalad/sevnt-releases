# SEVNT UPDATE SYSTEM
**Status:** Rancangan Arsitektur (Phase 2)
**Tanggal:** 2026-11-08

---

## OVERVIEW

Sistem update SEVNT memungkinkan app mendeteksi dan menginformasikan update tersedia kepada user.

**Flow:**
```
SEVNT Desktop (startup / Settings → About)
    │
    └── checkForUpdate(currentVersion, opts)
            │
            ├── GET https://api.github.com/repos/SEVNT-ORG/sevnt-releases/releases
            │   (atau GitHub Releases API dari repo SEVNT)
            │
            ├── pickLatestTag(releases, currentVersion, opts)
            │   → pilih tag terbaru yang sesuai (stable/beta)
            │
            └── compareVersions(latestTag, currentVersion)
                → newerAvailable: true | false
                → latestVersion: string
                → releaseNotes: string
                → downloadUrl: string
```

---

## INTERFACE: UpdateProvider

```javascript
// src/sevnt-update-check.js (SEVNT)

// Pure functions (tidak ada network/Electron dependency)
function compareVersions(a, b)       // -1 | 0 | 1
function isPrerelease(v)             // true jika ada pre-identifier (e.g. "-beta")
function pickLatestTag(releases, current, opts)  // tag string | ''

module.exports = { compareVersions, isPrerelease, pickLatestTag };
```

Fetch dilakukan di `main.js`:

```javascript
// Di main.js SEVNT
const UPDATE_REPO = 'SEVNT-ORG/sevnt-releases';  // ganti dengan repo resmi
const UPDATE_API  = `https://api.github.com/repos/${UPDATE_REPO}/releases`;

async function checkUpdate() {
  const res = await net.fetch(UPDATE_API, {
    headers: { 'User-Agent': 'SEVNT-Studio/APP_VERSION' }
  });
  const releases = await res.json();
  const opts = { includePrerelease: userPrefersPrerelease };
  const latest = pickLatestTag(releases, app.getVersion(), opts);
  if (!latest || compareVersions(latest, app.getVersion()) <= 0) return null;
  return { latest, downloadUrl: releaseDownloadUrl(latest) };
}
```

---

## UPDATE CHECK RULES

| Kondisi | Behavior |
|---------|----------|
| Install stable | Hanya tampilkan update stable (kecuali opt-in ke beta) |
| Install beta | Tampilkan semua release (stable + beta), pilih yang terbaru |
| Opt-in beta (stable install) | Tampilkan beta juga jika lebih baru dari versi stable terbaru |
| Draft release | Selalu diabaikan |

---

## SEMVER SCHEME

SEVNT menggunakan format: `MAJOR.MINOR.PATCH` atau `MAJOR.MINOR.PATCH-beta[.N]`

Contoh:
- `1.0.0` — stable
- `1.0.1` — patch stable
- `1.1.0-beta` — beta
- `1.1.0-beta.2` — beta revision
- `1.1.0` — stable (lebih baru dari semua 1.1.0-beta)

---

## GITHUB RELEASES STRUCTURE

Setiap release di GitHub repo `SEVNT-ORG/sevnt-releases` perlu:

```
Release: v1.1.0
  Tag: v1.1.0
  Title: SEVNT Studio 1.1.0
  Assets:
    - SEVNT-Studio-1.1.0-win-x64.exe
    - SEVNT-Studio-1.1.0-mac-arm64.dmg
    - SEVNT-Studio-1.1.0-mac-x64.dmg
  Body: Release notes (markdown)
```

---

## UPDATE MANIFEST (Opsional)

Jika tidak ingin bergantung pada GitHub API (rate limit, availability), dapat menggunakan manifest di server SEVNT:

```json
{
  "stable": {
    "version": "1.1.0",
    "releaseDate": "2026-11-08",
    "notes": "Improvement dan bug fix.",
    "downloads": {
      "win-x64": "https://releases.sevntstudio.com/v1.1.0/SEVNT-Studio-1.1.0-win-x64.exe",
      "mac-arm64": "https://releases.sevntstudio.com/v1.1.0/SEVNT-Studio-1.1.0-mac-arm64.dmg"
    },
    "sha256": {
      "win-x64": "<hash>",
      "mac-arm64": "<hash>"
    }
  },
  "beta": {
    "version": "1.2.0-beta",
    "..."
  }
}
```

Endpoint:
```
GET https://releases.sevntstudio.com/update-manifest.json
```

---

## FILE INTEGRITY

Setiap binary release HARUS disertai SHA256 hash yang diverifikasi sebelum install:

```javascript
// Di sevnt-update-system.js
async function downloadAndVerify(url, destPath, expectedSha256) {
  await download(url, destPath, onProgress);
  const actual = await sha256File(destPath);
  if (actual !== expectedSha256) throw new Error('File integrity check failed');
}
```

---

## ROLLBACK STRATEGY

- App tidak auto-update tanpa persetujuan user
- User mendownload installer baru, bukan in-place patch
- Versi lama tetap tersedia di GitHub releases

---

## KEBUTUHAN INFRASTRUKTUR

- [ ] GitHub Organization/Account SEVNT
- [ ] GitHub repo untuk releases: `SEVNT-ORG/sevnt-releases`
- [ ] (Opsional) Hosting update manifest: `releases.sevntstudio.com`
- [ ] CI/CD untuk build dan publish release (GitHub Actions)

---

## STATUS

- [ ] Logic semver (update-check.js): **DAPAT DIADOPSI** dari SOCL setelah review hak penggunaan
- [ ] GitHub repo SEVNT: **MENUNGGU** pembuatan org/repo
- [ ] Integrasi di main.js: **MENUNGGU** repo tersedia
- [ ] Testing: **BELUM**
