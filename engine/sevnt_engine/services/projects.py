from __future__ import annotations
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4
import json
from sevnt_engine.core.database import db_session


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def create_project(name: str, workspace_path: str | None = None) -> dict:
    project_id = str(uuid4())
    workspace = Path(workspace_path or (Path.home() / ".sevnt-studio" / "projects" / project_id)).expanduser().resolve()
    workspace.mkdir(parents=True, exist_ok=True)
    stamp = now()
    with db_session() as conn:
        conn.execute(
            "INSERT INTO projects(id,name,workspace_path,settings_json,created_at,updated_at) VALUES(?,?,?,?,?,?)",
            (project_id, name.strip(), str(workspace), json.dumps({"default_aspect_ratio":"9:16"}), stamp, stamp),
        )
        conn.execute(
            "INSERT INTO activity_events(id,project_id,entity_type,entity_id,event_type,message,created_at) VALUES(?,?,?,?,?,?,?)",
            (str(uuid4()), project_id, "project", project_id, "project.created", f"Project '{name.strip()}' dibuat", stamp),
        )
    return get_project(project_id)


def get_project(project_id: str) -> dict | None:
    with db_session() as conn:
        row = conn.execute("SELECT * FROM projects WHERE id=? AND status!='deleted'", (project_id,)).fetchone()
        return dict(row) if row else None


def list_projects() -> list[dict]:
    with db_session() as conn:
        return [dict(r) for r in conn.execute("SELECT * FROM projects WHERE status='active' ORDER BY updated_at DESC")]


def rename_project(project_id: str, name: str) -> dict | None:
    with db_session() as conn:
        cur = conn.execute("UPDATE projects SET name=?,updated_at=? WHERE id=? AND status!='deleted'", (name.strip(), now(), project_id))
        if not cur.rowcount: return None
    return get_project(project_id)


def archive_project(project_id: str) -> bool:
    with db_session() as conn:
        cur = conn.execute("UPDATE projects SET status='archived',updated_at=? WHERE id=? AND status='active'", (now(), project_id))
        return cur.rowcount > 0
