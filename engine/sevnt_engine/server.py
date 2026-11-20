"""SEVNT Studio local engine — launcher.

Started ONLY by the Electron app's EngineSupervisor:   python -m sevnt_engine.server

Required environment (all provided by the supervisor):
  SEVNT_ENGINE_TOKEN   per-launch secret; every request except GET /health must send  Authorization: Bearer <token>
  SEVNT_PARENT_PID     pid of the Electron main process; the engine exits by itself when that process disappears
Optional:
  SEVNT_ENGINE_PORT    0 (default) = let the OS choose a free port; the chosen port is printed on stdout
  SEVNT_DATA_DIR, SEVNT_FFMPEG, SEVNT_FFPROBE, HF_HOME

Only the approved S1 surface is mounted (health, system, ASR). The vendored B API (projects, licence, render,
YouTube import, transcript correction) is NOT imported here, by design.
"""

import asyncio
import hmac
import json
import os
import socket
import sys
import threading
import time

VERSION = "1.0.0-sevnt"
STARTED = time.time()


def pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    if sys.platform == "win32":
        import ctypes
        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        STILL_ACTIVE = 259
        h = ctypes.windll.kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)  # type: ignore[attr-defined]
        if not h:
            return False
        try:
            code = ctypes.c_ulong()
            ok = ctypes.windll.kernel32.GetExitCodeProcess(h, ctypes.byref(code))  # type: ignore[attr-defined]
            return bool(ok) and code.value == STILL_ACTIVE
        finally:
            ctypes.windll.kernel32.CloseHandle(h)  # type: ignore[attr-defined]
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def start_parent_watchdog(parent_pid: int, interval: float = 1.0) -> threading.Thread:
    """Exit the whole engine when the parent is gone (prevents orphan processes even if Electron is killed)."""
    def loop() -> None:
        while True:
            time.sleep(interval)
            if not pid_alive(parent_pid):
                os._exit(0)
    t = threading.Thread(target=loop, name="parent-watchdog", daemon=True)
    t.start()
    return t


def create_app(token: str):
    from fastapi import FastAPI, Request
    from fastapi.responses import JSONResponse
    from pydantic import BaseModel, Field

    from sevnt_engine import asr_service

    app = FastAPI(title="SEVNT Studio Local Engine", version=VERSION, docs_url=None, redoc_url=None, openapi_url=None)
    state = {"server": None}

    @app.middleware("http")
    async def auth(request: Request, call_next):
        if request.method == "GET" and request.url.path == "/health":
            return await call_next(request)
        header = request.headers.get("authorization", "")
        supplied = header[7:] if header.lower().startswith("bearer ") else ""
        if not supplied or not hmac.compare_digest(supplied.encode(), token.encode()):
            return JSONResponse({"error": "unauthorized"}, status_code=401, headers={"WWW-Authenticate": "Bearer"})
        return await call_next(request)

    class AsrRequest(BaseModel):
        audio_path: str = Field(min_length=3, max_length=4096)
        model: str = Field(default="small", pattern="^(tiny|base|small)$")
        language: str | None = Field(default="auto", max_length=12)
        vad: bool = True
        allow_download: bool = True

    @app.get("/health")
    def health():
        return {"status": "ok", "engine": "sevnt-local-engine", "version": VERSION, "uptime_s": round(time.time() - STARTED, 1)}

    @app.get("/api/v1/system/profile")
    def profile():
        import platform
        return {"platform": sys.platform, "machine": platform.machine(), "python": platform.python_version(),
                "pid": os.getpid(), "ffmpeg": os.environ.get("SEVNT_FFMPEG") or None, "ffprobe": os.environ.get("SEVNT_FFPROBE") or None}

    @app.get("/api/v1/system/whisper-capabilities")
    def whisper_caps():
        return asr_service.capabilities()

    @app.post("/api/v1/asr/transcribe", status_code=202)
    def asr_submit(body: AsrRequest):
        try:
            return asr_service.submit(body.audio_path, body.model, body.language, body.vad, body.allow_download)
        except asr_service.AsrError as exc:
            status = 409 if exc.code == "busy" else 400
            return JSONResponse({"error": exc.code, "message": exc.message}, status_code=status)

    @app.get("/api/v1/asr/jobs/{job_id}")
    def asr_get(job_id: str):
        job = asr_service.get(job_id)
        return job if job else JSONResponse({"error": "not_found"}, status_code=404)

    @app.delete("/api/v1/asr/jobs/{job_id}")
    def asr_cancel(job_id: str):
        job = asr_service.cancel(job_id)
        return job if job else JSONResponse({"error": "not_found"}, status_code=404)

    @app.post("/api/v1/shutdown")
    def shutdown():
        srv = state["server"]
        if srv is not None:
            threading.Timer(0.2, lambda: setattr(srv, "should_exit", True)).start()
        return {"status": "shutting_down"}

    app.state.holder = state
    return app


def main() -> int:
    token = os.environ.get("SEVNT_ENGINE_TOKEN", "")
    if len(token) < 16:
        print(json.dumps({"event": "error", "message": "SEVNT_ENGINE_TOKEN missing or too short"}), flush=True)
        return 2
    try:
        parent = int(os.environ.get("SEVNT_PARENT_PID", "0"))
    except ValueError:
        parent = 0
    if parent <= 0:
        print(json.dumps({"event": "error", "message": "SEVNT_PARENT_PID missing"}), flush=True)
        return 2
    try:
        want_port = int(os.environ.get("SEVNT_ENGINE_PORT", "0"))
    except ValueError:
        want_port = 0

    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.bind(("127.0.0.1", want_port))             # loopback only, never 0.0.0.0
    except OSError as exc:
        print(json.dumps({"event": "error", "message": f"cannot bind port {want_port}: {exc}"}), flush=True)
        return 3
    sock.listen(64)
    port = sock.getsockname()[1]

    import uvicorn
    app = create_app(token)
    server = uvicorn.Server(uvicorn.Config(app, log_level="warning", access_log=False, lifespan="off"))
    app.state.holder["server"] = server
    start_parent_watchdog(parent)
    print(json.dumps({"event": "listening", "port": port, "pid": os.getpid(), "version": VERSION}), flush=True)
    try:
        asyncio.run(server.serve(sockets=[sock]))
    finally:
        sock.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
