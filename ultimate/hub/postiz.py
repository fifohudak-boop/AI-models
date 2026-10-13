"""Client for the posting engine (Postiz) that your Fifofarm server runs.

Ultimate talks to the same engine as Fifofarm, through Postiz's public API, so accounts you
connected in Fifofarm can be used here too (and the other way round). Nothing in Fifofarm changes.
"""

from __future__ import annotations

import base64
import json
import mimetypes
import re
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlencode

import httpx

from . import settings


class PostizError(Exception):
    def __init__(self, message: str, status: int = 500, body: Any = None):
        super().__init__(message)
        self.status = status
        self.body = body


# Tests swap in a fake engine here.
_transport: httpx.AsyncBaseTransport | None = None


def set_transport(transport: httpx.AsyncBaseTransport | None) -> None:
    global _transport
    _transport = transport


def root_url(engine_url: str | None = None) -> str:
    """https://postiz.example.com (no /api)."""
    url = (engine_url if engine_url is not None else settings.get()["engineUrl"]).strip().rstrip("/")
    url = re.sub(r"/api(/public/v1)?$", "", url)
    return url


def api_base(engine_url: str | None = None) -> str:
    return f"{root_url(engine_url)}/api/public/v1"


def configured() -> bool:
    s = settings.get()
    return bool(s["engineUrl"].strip() and s["engineApiKey"].strip())


def _message(body: Any, fallback: str) -> str:
    if not body:
        return fallback
    if isinstance(body, str):
        return body[:500] or fallback
    if isinstance(body, dict):
        if body.get("provider") and body.get("error"):
            return str(body["error"])
        msg = body.get("msg") or body.get("message") or body.get("error")
        if isinstance(msg, list):
            return ", ".join(str(m) for m in msg)
        if isinstance(msg, str) and msg:
            return msg
    return fallback


def _client(timeout: float) -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=timeout, transport=_transport, follow_redirects=True)


async def call(path: str, *, method: str = "GET", json_body: Any = None, files: Any = None,
               api_key: str | None = None, engine_url: str | None = None, timeout: float = 60) -> Any:
    s = settings.get()
    key = api_key if api_key is not None else s["engineApiKey"]
    base = api_base(engine_url)
    if not root_url(engine_url):
        raise PostizError("Connect your posting engine first (Settings → Posting engine).", 424)
    if not key:
        raise PostizError("No posting engine API key saved yet (Settings → Posting engine).", 424)
    headers = {"Authorization": key}
    try:
        async with _client(timeout) as client:
            resp = await client.request(method, f"{base}{path}", headers=headers, json=json_body, files=files)
    except httpx.TimeoutException as exc:
        raise PostizError("The posting engine didn't answer in time. Is your server running?", 503) from exc
    except httpx.HTTPError as exc:
        raise PostizError(f"Can't reach the posting engine ({type(exc).__name__}). Is your server running?", 503) from exc
    try:
        body = resp.json() if resp.content else None
    except ValueError:
        body = resp.text
    if resp.status_code >= 400:
        fallback = ("The posting engine rejected the API key." if resp.status_code == 401
                    else f"The posting engine returned HTTP {resp.status_code}.")
        raise PostizError(_message(body, fallback), resp.status_code, body)
    return body


async def check_key(api_key: str | None = None, engine_url: str | None = None) -> Any:
    return await call("/is-connected", api_key=api_key, engine_url=engine_url, timeout=20)


async def key_from_login(engine_url: str, email: str, password: str) -> str:
    """Sign in to Postiz with its own login and read its public API key."""
    root = root_url(engine_url)
    try:
        async with _client(30) as client:
            resp = await client.post(f"{root}/api/auth/login",
                                     json={"email": email, "password": password, "provider": "LOCAL"})
            if resp.status_code >= 400:
                raise PostizError("Postiz didn't accept that email and password.", 400)
            jwt = resp.headers.get("auth") or resp.cookies.get("auth")
            if not jwt:
                match = re.search(r"auth=([^;]+)", resp.headers.get("set-cookie", ""))
                jwt = match.group(1) if match else None
            if not jwt:
                raise PostizError("Postiz signed you in but sent no login token back.", 502)
            me = await client.get(f"{root}/api/user/self", headers={"auth": jwt, "Cookie": f"auth={jwt}"})
    except httpx.HTTPError as exc:
        raise PostizError(f"Can't reach {root} ({type(exc).__name__}).", 503) from exc
    try:
        key = me.json().get("publicApi")
    except ValueError:
        key = None
    if me.status_code >= 400 or not isinstance(key, str) or not key:
        raise PostizError("Signed in, but couldn't read the API key. Copy it from Postiz → Settings instead.", 502)
    return key


async def list_integrations() -> list[dict]:
    res = await call("/integrations")
    return res if isinstance(res, list) else []


async def integration_max_length(integration_id: str) -> int:
    res = await call(f"/integration-settings/{quote(integration_id, safe='')}")
    try:
        return int((res or {}).get("output", {}).get("maxLength") or 0)
    except (TypeError, ValueError, AttributeError):
        return 0


async def connect_url(provider: str) -> str:
    res = await call(f"/social/{quote(provider, safe='')}")
    url = (res or {}).get("url") if isinstance(res, dict) else None
    if not url:
        raise PostizError("The posting engine didn't give a sign-in link for that network.", 502)
    return url


async def connect_with_fields(provider: str, fields: dict) -> Any:
    """Networks that log in with fields instead of OAuth (Bluesky)."""
    state = await connect_url(provider)
    root = root_url()
    code = base64.b64encode(json.dumps(fields).encode()).decode()
    try:
        async with _client(60) as client:
            resp = await client.post(f"{root}/api/integrations/social-connect/{quote(provider, safe='')}",
                                     json={"state": state, "code": code, "timezone": "0"})
    except httpx.HTTPError as exc:
        raise PostizError(f"Can't reach the posting engine ({type(exc).__name__}).", 503) from exc
    if resp.status_code >= 400:
        try:
            body = resp.json()
        except ValueError:
            body = resp.text
        raise PostizError(_message(body, f"HTTP {resp.status_code}"), resp.status_code, body)
    return resp.json() if resp.content else None


async def delete_integration(integration_id: str) -> Any:
    return await call(f"/integrations/{quote(integration_id, safe='')}", method="DELETE")


async def pinterest_boards(integration_id: str) -> list[dict]:
    res = await call(f"/integration-trigger/{quote(integration_id, safe='')}", method="POST",
                     json_body={"methodName": "boards", "data": {}})
    output = (res or {}).get("output") if isinstance(res, dict) else None
    return output if isinstance(output, list) else []


async def upload(file_path: Path, mime_type: str | None = None) -> dict:
    mime = mime_type or mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
    with file_path.open("rb") as fh:
        res = await call("/upload", method="POST", files={"file": (file_path.name, fh, mime)}, timeout=30 * 60)
    if not isinstance(res, dict) or not res.get("path"):
        raise PostizError("The posting engine didn't store the file.", 502, res)
    return res


async def create_post(body: dict) -> Any:
    return await call("/posts", method="POST", json_body=body)


async def list_posts(start_iso: str, end_iso: str) -> list[dict]:
    res = await call(f"/posts?{urlencode({'startDate': start_iso, 'endDate': end_iso})}")
    if isinstance(res, dict):
        return res.get("posts") or []
    return res if isinstance(res, list) else []


async def delete_post(post_id: str) -> Any:
    return await call(f"/posts/{quote(post_id, safe='')}", method="DELETE")


async def notifications() -> list[dict]:
    res = await call("/notifications?page=0")
    if isinstance(res, dict):
        return res.get("notifications") or []
    return res if isinstance(res, list) else []


async def post_analytics(post_id: str, days: int = 30) -> Any:
    return await call(f"/analytics/post/{quote(post_id, safe='')}?date={days}", timeout=45)


async def account_analytics(integration_id: str, days: int = 30) -> list[dict]:
    res = await call(f"/analytics/{quote(integration_id, safe='')}?date={days}", timeout=45)
    return res if isinstance(res, list) else []


def with_account_chooser(identifier: str, url: str) -> str:
    """Make the network ask which account to use instead of reusing the one you're logged in to."""
    if not url:
        return url

    def add(param: str) -> str:
        return f"{url}{'&' if '?' in url else '?'}{param}"

    if identifier == "instagram-standalone":
        return url if re.search(r"[?&]force_reauth=", url) else add("force_reauth=true")
    if identifier == "tiktok":
        return url if re.search(r"[?&]disable_auto_auth=", url) else add("disable_auto_auth=1")
    if identifier == "youtube":
        if re.search(r"[?&]prompt=", url):
            return re.sub(r"([?&]prompt=)[^&]*", r"\1select_account%20consent", url)
        return add("prompt=select_account%20consent")
    if identifier == "x":
        if re.search(r"[?&]force_login=", url):
            return re.sub(r"([?&]force_login=)[^&]*", r"\1true", url)
        return add("force_login=true")
    return url
