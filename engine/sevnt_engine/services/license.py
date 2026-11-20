"""
License service untuk SEVNT Studio.

Model: per-user, one-time license key, max 2 aktivasi per key.
Key format: SEVNT-XXXX-XXXX-XXXX-XXXX (base-32 chars, huruf besar + digit tanpa 0/O/I/L)
"""
from __future__ import annotations
import hashlib, hmac, json, os, platform, secrets, socket, time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from sevnt_engine.core.database import db_session, APP_DIR

# ── Konstanta ────────────────────────────────────────────────────────────────
MAX_DEVICES_PER_KEY = 2
TOKEN_TTL_SECONDS   = 7 * 24 * 3600   # re-validate setiap 7 hari (saat online)
TOKEN_GRACE_SECONDS = 30 * 24 * 3600  # grace offline max 30 hari

# Secret untuk sign token lokal — di produksi embed via env atau binary obfuscation.
# Ganti dengan nilai acak 64-char di saat rilis.
_LOCAL_SIGN_SECRET = os.getenv(
    "SEVNT_LICENSE_SECRET",
    "sv$3NtL!c3ns3S3cr3tKEY__ch4ng3_m3_4t_pr0d__2025",
)

CACHE_PATH = APP_DIR / "license_cache.json"

# ── Alphabet bebas ambiguitas (tanpa 0,O,I,L,1) ───────────────────────────
_ALPHA = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"


# ══════════════════════════════════════════════════════════════════════════════
# Utilitas
# ══════════════════════════════════════════════════════════════════════════════

def _sign(data: str) -> str:
    return hmac.new(_LOCAL_SIGN_SECRET.encode(), data.encode(), hashlib.sha256).hexdigest()


def _machine_fingerprint() -> str:
    """Hash deterministik dari hostname + username + platform — dipakai sebagai device_id."""
    raw = f"{socket.gethostname()}::{os.getlogin()}::{platform.system()}::{platform.machine()}"
    return hashlib.sha256(raw.encode()).hexdigest()[:32]


def _device_label() -> str:
    return f"{socket.gethostname()} ({platform.system()})"


def generate_key() -> str:
    """Buat satu license key acak. Panggil dari admin script/CLI."""
    parts = []
    for _ in range(4):
        chunk = "".join(secrets.choice(_ALPHA) for _ in range(4))
        parts.append(chunk)
    return "SEVNT-" + "-".join(parts)


def _normalize_key(raw: str) -> str:
    """Uppercase + hapus spasi — toleran input user."""
    return raw.strip().upper().replace(" ", "").replace("\t", "")


# ══════════════════════════════════════════════════════════════════════════════
# Token cache lokal
# ══════════════════════════════════════════════════════════════════════════════

def _save_cache(payload: dict[str, Any]) -> None:
    APP_DIR.mkdir(parents=True, exist_ok=True)
    data = json.dumps(payload, separators=(",", ":"))
    sig  = _sign(data)
    CACHE_PATH.write_text(json.dumps({"d": data, "s": sig}), encoding="utf-8")


def _load_cache() -> dict[str, Any] | None:
    try:
        raw   = json.loads(CACHE_PATH.read_text(encoding="utf-8"))
        data  = raw["d"]
        sig   = raw["s"]
        if not hmac.compare_digest(_sign(data), sig):
            return None   # cache dimanipulasi
        return json.loads(data)
    except Exception:
        return None


def _clear_cache() -> None:
    CACHE_PATH.unlink(missing_ok=True)


# ══════════════════════════════════════════════════════════════════════════════
# Skema DB — dipanggil dari initialize_database
# ══════════════════════════════════════════════════════════════════════════════

LICENSE_SCHEMA = """
CREATE TABLE IF NOT EXISTS license_keys (
    id          TEXT PRIMARY KEY,
    key_raw     TEXT NOT NULL UNIQUE,
    status      TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','suspended','revoked')),
    max_devices INTEGER NOT NULL DEFAULT 2,
    note        TEXT,
    created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS license_activations (
    id          TEXT PRIMARY KEY,
    key_id      TEXT NOT NULL REFERENCES license_keys(id) ON DELETE CASCADE,
    device_id   TEXT NOT NULL,
    device_label TEXT NOT NULL,
    activated_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','deactivated')),
    UNIQUE(key_id, device_id)
);
"""


def ensure_license_schema() -> None:
    """Dipanggil dari startup — idempotent."""
    with db_session() as conn:
        conn.executescript(LICENSE_SCHEMA)


# ══════════════════════════════════════════════════════════════════════════════
# Core logic
# ══════════════════════════════════════════════════════════════════════════════

def _key_row(conn, key_raw: str):
    return conn.execute(
        "SELECT * FROM license_keys WHERE key_raw = ? AND status = 'active'",
        (key_raw,)
    ).fetchone()


def _active_activations(conn, key_id: str):
    return conn.execute(
        "SELECT * FROM license_activations WHERE key_id = ? AND status = 'active'",
        (key_id,)
    ).fetchall()


def activate(key_input: str) -> dict[str, Any]:
    """
    Aktivasi key di device ini.
    Return: {status, key, device_id, device_label, activated_at, message}
    Raise: ValueError dengan pesan yang bisa ditampilkan ke user.
    """
    key_raw   = _normalize_key(key_input)
    device_id = _machine_fingerprint()
    label     = _device_label()
    now       = datetime.now(timezone.utc).isoformat()

    with db_session() as conn:
        row = _key_row(conn, key_raw)
        if not row:
            raise ValueError("License key tidak valid atau sudah dicabut.")

        key_id      = row["id"]
        max_devices = row["max_devices"]

        # Sudah aktif di device ini?
        existing = conn.execute(
            "SELECT * FROM license_activations WHERE key_id = ? AND device_id = ? AND status = 'active'",
            (key_id, device_id)
        ).fetchone()
        if existing:
            # Re-aktivasi: update last_seen saja
            conn.execute(
                "UPDATE license_activations SET last_seen_at = ? WHERE id = ?",
                (now, existing["id"])
            )
            activated_at = existing["activated_at"]
        else:
            actives = _active_activations(conn, key_id)
            if len(actives) >= max_devices:
                labels = ", ".join(a["device_label"] for a in actives)
                raise ValueError(
                    f"License key sudah dipakai di {len(actives)}/{max_devices} device: {labels}. "
                    "Nonaktifkan salah satu di Settings sebelum aktivasi di sini."
                )
            import uuid as _uuid
            conn.execute(
                "INSERT INTO license_activations (id,key_id,device_id,device_label,activated_at,last_seen_at,status) "
                "VALUES (?,?,?,?,?,?,'active')",
                (_uuid.uuid4().hex, key_id, device_id, label, now, now)
            )
            activated_at = now

    result = {
        "status":       "active",
        "key":          _mask_key(key_raw),
        "key_raw":      key_raw,
        "device_id":    device_id,
        "device_label": label,
        "activated_at": activated_at,
        "last_seen_at": now,
        "message":      "Lisensi aktif.",
    }
    _save_cache({**result, "cached_at": time.time()})
    return result


def deactivate(key_input: str | None = None) -> dict[str, Any]:
    """
    Nonaktifkan device ini dari key. key_input boleh None jika sudah ada cache.
    """
    cache = _load_cache()
    key_raw = _normalize_key(key_input) if key_input else (cache or {}).get("key_raw")
    if not key_raw:
        raise ValueError("Tidak ada lisensi aktif di device ini.")

    device_id = _machine_fingerprint()
    now       = datetime.now(timezone.utc).isoformat()

    with db_session() as conn:
        conn.execute(
            "UPDATE license_activations SET status='deactivated', last_seen_at=? "
            "WHERE key_id=(SELECT id FROM license_keys WHERE key_raw=?) AND device_id=?",
            (now, key_raw, device_id)
        )
    _clear_cache()
    return {"status": "deactivated", "device_id": device_id, "message": "Perangkat dinonaktifkan."}


def status() -> dict[str, Any]:
    """
    Cek status lisensi device ini.
    1. Dari cache lokal (cepat, offline-capable)
    2. Verifikasi signature cache
    Return: {status: 'active'|'inactive'|'grace', ...}
    """
    cache = _load_cache()
    if not cache:
        return {"status": "inactive", "message": "Belum diaktifkan."}

    device_id = _machine_fingerprint()
    if cache.get("device_id") != device_id:
        _clear_cache()
        return {"status": "inactive", "message": "Cache tidak cocok dengan perangkat ini."}

    # Verifikasi ke DB lokal
    key_raw = cache.get("key_raw")
    if key_raw:
        try:
            with db_session() as conn:
                row = _key_row(conn, key_raw)
                if not row:
                    _clear_cache()
                    return {"status": "inactive", "message": "License key tidak valid."}
                act = conn.execute(
                    "SELECT * FROM license_activations WHERE key_id=? AND device_id=? AND status='active'",
                    (row["id"], device_id)
                ).fetchone()
                if not act:
                    _clear_cache()
                    return {"status": "inactive", "message": "Aktivasi tidak ditemukan."}
                # Update last_seen
                now = datetime.now(timezone.utc).isoformat()
                conn.execute(
                    "UPDATE license_activations SET last_seen_at=? WHERE id=?",
                    (now, act["id"])
                )
                return {
                    "status":       "active",
                    "key":          _mask_key(key_raw),
                    "device_id":    device_id,
                    "device_label": cache.get("device_label", _device_label()),
                    "activated_at": act["activated_at"],
                    "last_seen_at": now,
                    "message":      "Lisensi aktif.",
                }
        except Exception:
            pass

    # DB tidak tersedia — gunakan cache (grace mode)
    cached_at = cache.get("cached_at", 0)
    age = time.time() - cached_at
    if age <= TOKEN_GRACE_SECONDS:
        return {**cache, "status": "grace", "message": f"Mode offline — cache {int(age/86400)}h lalu."}

    _clear_cache()
    return {"status": "inactive", "message": "Cache expired. Aktifkan ulang."}


def list_activations(key_input: str) -> list[dict[str, Any]]:
    """Tampilkan semua device yang aktif untuk key ini."""
    key_raw = _normalize_key(key_input)
    with db_session() as conn:
        row = _key_row(conn, key_raw)
        if not row:
            raise ValueError("License key tidak valid.")
        rows = conn.execute(
            "SELECT device_id,device_label,activated_at,last_seen_at,status FROM license_activations WHERE key_id=?",
            (row["id"],)
        ).fetchall()
        return [dict(r) for r in rows]


def admin_create_key(note: str = "", max_devices: int = 2) -> dict[str, Any]:
    """
    Buat license key baru dan simpan ke DB.
    Gunakan dari admin CLI / script distribusi.
    """
    import uuid as _uuid
    key_raw = generate_key()
    now     = datetime.now(timezone.utc).isoformat()
    with db_session() as conn:
        conn.execute(
            "INSERT INTO license_keys (id,key_raw,status,max_devices,note,created_at) VALUES (?,?,?,?,?,?)",
            (_uuid.uuid4().hex, key_raw, "active", max_devices, note, now)
        )
    return {"key": key_raw, "max_devices": max_devices, "note": note, "created_at": now}


def admin_revoke_key(key_input: str) -> dict[str, Any]:
    key_raw = _normalize_key(key_input)
    with db_session() as conn:
        conn.execute("UPDATE license_keys SET status='revoked' WHERE key_raw=?", (key_raw,))
    return {"revoked": True, "key": _mask_key(key_raw)}


def _mask_key(key: str) -> str:
    parts = key.split("-")
    if len(parts) >= 2:
        return parts[0] + "-" + "-".join("•" * len(p) for p in parts[1:])
    return "•" * len(key)
