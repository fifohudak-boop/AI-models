"""The local web server behind Fifofarm Ultimate (only reachable from this Mac)."""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import (
    analytics, auth, db, media, personas, postiz, reels_api, routes_auth, routes_core, routes_edit, routes_meta,
    routes_posting, routes_studio, settings, studio,
)
from .config import BRAND_NAME, WEB_DIR, ensure_dirs
from .events import bus

log = logging.getLogger("ultimate")
LOCAL_HOSTS = {"127.0.0.1", "localhost"}
HEADER = "x-ultimate"


def _host_of(headers) -> str:
    return (headers.get("host") or "").rsplit(":", 1)[0].strip("[]").lower()


def allowed_hosts() -> set[str]:
    """localhost always; the share address too once you've turned sharing on."""
    hosts = set(LOCAL_HOSTS)
    s = settings.get()
    share = (s.get("shareHost") or "").strip().lower()
    if s.get("sharingEnabled") and share:
        hosts.add(share)
    return hosts


def _resolve_user(connection, host: str) -> dict | None:
    """Who is making this request: you (on localhost) or a logged-in person (by session cookie)."""
    if host in LOCAL_HOSTS:
        return auth.OWNER_LOCAL
    return auth.user_for_token(connection.cookies.get(auth.COOKIE) or "")


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
async def gate(request: Request, call_next):
    # Only answer on localhost (and the share address, once sharing is on): blocks DNS-rebinding and
    # other websites poking this server from your browser.
    host = _host_of(request.headers)
    if host not in allowed_hosts():
        return JSONResponse({"error": f"{BRAND_NAME} isn't reachable at that address."}, status_code=403)
    if request.method not in ("GET", "HEAD", "OPTIONS") and request.headers.get(HEADER) != "1":
        return JSONResponse({"error": "Missing X-Ultimate header."}, status_code=403)
    path = request.url.path
    if path.startswith("/api/"):
        user = _resolve_user(request, host)
        verdict = auth.authorize(user, request.method, path)
        if verdict:
            return JSONResponse({"error": verdict[1], "detail": verdict[1]}, status_code=verdict[0])
        request.state.user = user
    response = await call_next(request)
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


@app.exception_handler(auth.AuthError)
async def auth_error(_request: Request, exc: auth.AuthError) -> JSONResponse:
    return _error(400, str(exc))


app.include_router(routes_auth.router)
app.include_router(routes_core.router)
app.include_router(routes_posting.router)
app.include_router(reels_api.router)
app.include_router(routes_studio.router)
app.include_router(routes_edit.router)
app.include_router(routes_meta.router)


@app.get("/api/health")
async def health() -> dict:
    return {"ok": True}


@app.websocket("/ws")
async def events(ws: WebSocket) -> None:
    host = _host_of(ws.headers)
    if host not in allowed_hosts():
        await ws.close(code=1008)
        return
    origin_host = (ws.headers.get("origin") or "").split("://")[-1].rsplit(":", 1)[0].strip("[]").lower()
    if origin_host and origin_host not in allowed_hosts():
        await ws.close(code=1008)
        return
    user = _resolve_user(ws, host)
    if user is None:
        await ws.close(code=1008)
        return
    allowed = auth.allowed_models(user)  # None = every model (the owner)
    model = ws.query_params.get("model") or None
    if model and allowed is not None and model not in allowed:
        await ws.close(code=1008)
        return
    await ws.accept()
    queue = bus.subscribe()

    async def forward() -> None:
        await ws.send_json({"type": "snapshot", "model": model, "data": reels_api.snapshot(model)})
        for test in reels_api.selftest_states():  # a refreshed page still shows the last results
            await ws.send_json({"type": "selftest", "model": None, "data": test})
        while True:
            message = await queue.get()
            about = message.get("model")
            if about is not None and allowed is not None and about not in allowed:
                continue  # another model's event — not for this person
            await ws.send_json(message)

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
