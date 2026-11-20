from __future__ import annotations
import os, sqlite3
from pathlib import Path
from contextlib import contextmanager

APP_DIR = Path(os.getenv("SEVNT_DATA_DIR", Path.home() / ".sevnt-studio"))
DB_PATH = Path(os.getenv("SEVNT_DB_PATH", APP_DIR / "sevnt.db"))
SCHEMA_PATH = Path(__file__).with_name("schema.sql")


def connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA busy_timeout = 30000")
    return conn


@contextmanager
def db_session():
    conn = connect()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def initialize_database() -> None:
    schema = SCHEMA_PATH.read_text(encoding="utf-8")
    with db_session() as conn:
        conn.executescript(schema)
        conn.execute(
            "INSERT OR IGNORE INTO schema_migrations(version, applied_at, description) VALUES(1, datetime('now'), ?)",
            ("Initial SEVNT core schema",),
        )
