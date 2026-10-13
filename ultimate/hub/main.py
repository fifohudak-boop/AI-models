"""The local web server behind Fifofarm Ultimate (only reachable from this Mac)."""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import analytics, db, media, personas, postiz, reels_api, routes_core, routes_posting, routes_studio, studio
from .config import WEB_DIR, ensure_dirs
from .events import bus

log = logging.getLogger("ultimate")
ALLOWED_HOSTS = {"127.0.0.1", "localhost"}
HEADER = "x-ultimate"


@asynccontextmanager
async def lifespan(_app: FastAPI):
    ensure_dirs()
    db.open_db()
    media.clean_tmp()
    reels_api.on_startup()
    background = [
        asyncio.create_task(analytics.analytics_loop()),
        asyncio.create_task(studio.poll_loop()),
        asyncio.create_task(routes_core.watch_for_updates()),
    ]
    yield
    for task in background:
        task.cancel()
    await reels_api.on_shutdown()


app = FastAPI(title="Fifofarm Ultimate", lifespan=lifespan)


@app.middleware("http")
async def local_only(request: Request, call_next):
    # Block DNS-rebinding and other websites poking this local server from your browser.
    host = (request.headers.get("host") or "").rsplit(":", 1)[0].strip("[]")
    if host not in ALLOWED_HOSTS:
        return JSONResponse({"error": "Fifofarm Ultimate only answers on localhost."}, status_code=403)
    if request.method not in ("GET", "HEAD", "OPTIONS") and request.headers.get(HEADER) != "1":
        return JSONResponse({"error": "Missing X-Ultimate header."}, status_code=403)
    response = await call_next(request)
    path = request.url.path
    if path.startswith("/api/") and "Cache-Control" not in response.headers:
        response.headers["Cache-Control"] = "no-store"
    elif not path.startswith("/assets/") and not path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-cache"  # the page itself: always the newest version
    return response


def _error(status: int, message: str) -> JSONResponse:
    return JSONResponse({"error": message, "detail": message}, status_code=status)


@app.exception_handler(HTTPException)
async def http_error(_request: Request, exc: HTTPException) -> JSONResponse:
    return _error(exc.status_code, str(exc.detail))


@app.exception_handler(RequestValidationError)
async def validation_error(_request: Request, exc: RequestValidationError) -> JSONResponse:
    first = exc.errors()[0] if exc.errors() else {}
    where = ".".join(str(p) for p in first.get("loc", [])[1:])
    return _error(400, f"{where}: {first.get('msg', 'invalid')}" if where else "Invalid request.")


@app.exception_handler(postiz.PostizError)
async def postiz_error(_request: Request, exc: postiz.PostizError) -> JSONResponse:
    status = 424 if exc.status in (401, 424) else 502 if exc.status >= 500 else 400
    return JSONResponse({"error": str(exc), "detail": str(exc), "engine": True}, status_code=status)


@app.exception_handler(personas.PersonaError)
async def persona_error(_request: Request, exc: personas.PersonaError) -> JSONResponse:
    return _error(400, str(exc))


@app.exception_handler(studio.StudioError)
async def studio_error(_request: Request, exc: studio.StudioError) -> JSONResponse:
    return _error(exc.status, str(exc))


app.include_router(routes_core.router)
app.include_router(routes_posting.router)
app.include_router(reels_api.router)
app.include_router(routes_studio.router)


@app.get("/api/health")
async def health() -> dict:
    return {"ok": True}


@app.websocket("/ws")
async def events(ws: WebSocket) -> None:
    origin_host = (ws.headers.get("origin") or "").split("://")[-1].rsplit(":", 1)[0]
    if origin_host and origin_host not in ALLOWED_HOSTS:
        await ws.close(code=1008)
        return
    await ws.accept()
    model = ws.query_params.get("model") or None
    queue = bus.subscribe()

    async def forward() -> None:
        await ws.send_json({"type": "snapshot", "model": model, "data": reels_api.snapshot(model)})
        for test in reels_api.selftest_states():  # a refreshed page still shows the last results
            await ws.send_json({"type": "selftest", "model": None, "data": test})
        while True:
            await ws.send_json(await queue.get())

    sender = asyncio.create_task(forward())
    try:
        while True:  # reading is what notices a closed tab
            await ws.receive_text()
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        sender.cancel()
        bus.unsubscribe(queue)


@app.api_route("/api/{rest:path}", methods=["GET", "POST", "PUT", "DELETE"], include_in_schema=False)
async def api_not_found(rest: str) -> JSONResponse:
    return _error(404, "Not found.")


if (WEB_DIR / "assets").is_dir():
    app.mount("/assets", StaticFiles(directory=WEB_DIR / "assets"), name="assets")


@app.get("/{path:path}", include_in_schema=False)
async def page(path: str) -> FileResponse:
    candidate = (WEB_DIR / path).resolve()
    if path and candidate.is_file() and WEB_DIR.resolve() in candidate.parents:
        return FileResponse(candidate)
    index = WEB_DIR / "index.html"
    if not index.exists():
        raise HTTPException(503, "The page isn't built yet (web/index.html is missing).")
    return FileResponse(index)
