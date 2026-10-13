"""Fifofarm inside Ultimate: accounts, posting, history and analytics — all per model.

Works like Fifofarm's own server (copied from it), but each model only sees and posts to its own
accounts, and its History and Analytics only show what was posted for it.
"""

from __future__ import annotations

import asyncio
import time
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from . import accounts as account_store
from . import analytics, batches, media, personas, postiz, settings
from .platforms import (
    build_post_request, count_length, is_supported, platform_catalog, platform_name, preflight,
)
from .settings import DEFAULT_PREFERENCES, PREFERENCE_RULES

router = APIRouter()


def _model(model_id: str) -> dict:
    try:
        return personas.require(model_id)
    except personas.PersonaError as exc:
        raise HTTPException(404, str(exc)) from exc


# ---------------------------------------------------------------- preferences

@router.get("/api/platforms")
async def platforms() -> list[dict]:
    return platform_catalog()


@router.get("/api/preferences")
async def get_preferences() -> dict:
    return settings.get()["preferences"]


@router.put("/api/preferences")
async def put_preferences(body: dict) -> dict:
    patch: dict[str, Any] = {}
    for key, value in body.items():
        rule = PREFERENCE_RULES.get(key)
        if not rule:
            raise HTTPException(400, f"Unknown setting: {key}")
        if not rule(value):
            raise HTTPException(400, f"Invalid value for {key}")
        patch[key] = value
    if "pinterestBoards" in patch:
        patch["pinterestBoards"] = {**settings.get()["preferences"].get("pinterestBoards", {}), **patch["pinterestBoards"]}
    return settings.save({"preferences": patch})["preferences"]


# ---------------------------------------------------------------- accounts

class _Cache:
    accounts: tuple[float, list[dict]] | None = None
    max_length: dict[str, tuple[float, int]] = {}


async def _max_length(account_id: str) -> int:
    cached = _Cache.max_length.get(account_id)
    if cached and cached[0] > time.time() - 600:
        return cached[1]
    try:
        value = await postiz.integration_max_length(account_id)
    except postiz.PostizError:
        value = cached[1] if cached else 0
    _Cache.max_length[account_id] = (time.time(), value)
    return value


async def load_accounts(fresh: bool = False) -> list[dict]:
    if not fresh and _Cache.accounts and _Cache.accounts[0] > time.time() - 5:
        return _Cache.accounts[1]
    raw = await postiz.list_integrations()
    account_store.claim_new_accounts(raw)
    lengths = await asyncio.gather(*(_max_length(a["id"]) for a in raw))
    value = [
        {
            "id": a["id"],
            "name": a.get("name") or a["id"],
            "identifier": a.get("identifier") or "",
            "picture": a.get("picture") or None,
            "profile": a.get("profile") or None,
            "disabled": bool(a.get("disabled")),
            "platform": platform_name(a.get("identifier") or ""),
            "supported": is_supported(a.get("identifier") or ""),
            "maxLength": n,
        }
        for a, n in zip(raw, lengths)
    ]
    _Cache.accounts = (time.time(), value)
    return value


def forget_accounts() -> None:
    _Cache.accounts = None


async def model_accounts(model_id: str, fresh: bool = False) -> list[dict]:
    return account_store.accounts_of(model_id, await load_accounts(fresh))


@router.get("/api/m/{model_id}/accounts")
async def list_model_accounts(model_id: str) -> list[dict]:
    _model(model_id)
    return await model_accounts(model_id, fresh=True)


@router.get("/api/accounts")
async def list_all_accounts() -> list[dict]:
    names = {p["id"]: p["name"] for p in personas.list_all()}
    return account_store.label_accounts(await load_accounts(fresh=True), names)


class AssignBody(BaseModel):
    modelId: str | None = None


@router.put("/api/accounts/{account_id}/model")
async def assign_account(account_id: str, body: AssignBody) -> list[dict]:
    if body.modelId:
        _model(body.modelId)
    if not any(a["id"] == account_id for a in await load_accounts()):
        raise HTTPException(404, "Account not found.")
    account_store.assign(account_id, body.modelId)
    return await list_all_accounts()


class ConnectBody(BaseModel):
    provider: str
    another: bool = False


def _oauth_network(provider: str) -> dict:
    entry = next((p for p in platform_catalog() if p["identifier"] == provider), None)
    if not entry or entry["connect"] != "oauth":
        raise HTTPException(400, "Unknown network.")
    return entry


async def _start_connect(model_id: str, provider: str) -> None:
    account_store.record_pending_connect(model_id, provider, [a["id"] for a in await load_accounts(fresh=True)])


async def _connect_url(provider: str) -> str:
    try:
        return await postiz.connect_url(provider)
    except postiz.PostizError as exc:
        if exc.status < 500 and exc.status not in (401, 424):
            name = platform_name(provider)
            raise HTTPException(400, f"{name} isn't set up on your posting engine yet — set it up in Fifofarm first "
                                     f"(Accounts → {name} → Set up).") from exc
        raise


@router.post("/api/m/{model_id}/accounts/connect")
async def connect(model_id: str, body: ConnectBody) -> dict:
    _model(model_id)
    _oauth_network(body.provider)
    await _start_connect(model_id, body.provider)
    url = await _connect_url(body.provider)
    return {"url": postiz.with_account_chooser(body.provider, url) if body.another else url}


@router.post("/api/m/{model_id}/accounts/connect-link")
async def connect_link(model_id: str, body: ConnectBody) -> dict:
    _model(model_id)
    _oauth_network(body.provider)
    await _start_connect(model_id, body.provider)
    url = postiz.with_account_chooser(body.provider, await _connect_url(body.provider))
    return {"url": url, "expiresAt": batches.iso(time.time() + 55 * 60)}


class BlueskyBody(BaseModel):
    handle: str
    appPassword: str
    service: str | None = None


@router.post("/api/m/{model_id}/accounts/bluesky")
async def connect_bluesky(model_id: str, body: BlueskyBody) -> dict:
    _model(model_id)
    if not body.handle.strip() or not body.appPassword.strip():
        raise HTTPException(400, "Enter your Bluesky handle and an app password.")
    await _start_connect(model_id, "bluesky")
    try:
        await postiz.connect_with_fields("bluesky", {
            "service": (body.service or "").strip() or "https://bsky.social",
            "identifier": body.handle.strip().lstrip("@"),
            "password": body.appPassword.strip(),
        })
    except postiz.PostizError as exc:
        if exc.status < 500:
            raise HTTPException(400, "Bluesky refused that handle or app password.") from exc
        raise
    await load_accounts(fresh=True)  # attribute the new account while the connect is fresh
    return {"ok": True}


@router.get("/api/accounts/{account_id}/boards")
async def pinterest_boards(account_id: str) -> list[dict]:
    if not any(a["id"] == account_id for a in await load_accounts()):
        raise HTTPException(404, "Account not found.")
    return await postiz.pinterest_boards(account_id)


# ---------------------------------------------------------------- media

@router.post("/api/media", status_code=202)
async def upload_media(request: Request, name: str = "video") -> dict:
    """The file arrives as the raw request body, straight from the page."""
    target = media.new_upload_path()
    size = 0
    try:
        with target.open("wb") as fh:
            async for chunk in request.stream():
                size += len(chunk)
                if size > media.MAX_UPLOAD_BYTES:
                    raise HTTPException(413, "That file is over 4 GB.")
                fh.write(chunk)
    except BaseException:
        target.unlink(missing_ok=True)
        raise
    if size == 0:
        target.unlink(missing_ok=True)
        raise HTTPException(400, "No file received.")
    return media.start_upload_job(target, Path(name).name or "video")


class LocalMediaBody(BaseModel):
    path: str


@router.post("/api/m/{model_id}/media/local", status_code=202)
async def local_media(model_id: str, body: LocalMediaBody) -> dict:
    persona = _model(model_id)
    file = Path(body.path).expanduser()
    if not file.is_file() or not personas.inside_folders(persona, file):
        raise HTTPException(404, "That file isn't in this model's folders.")
    return media.start_local_job(file)


@router.get("/api/media/{job_id}")
async def media_job(job_id: str) -> dict:
    job = media.get_job(job_id)
    if not job:
        raise HTTPException(404, "Upload not found — add the file again.")
    return job


# ---------------------------------------------------------------- posting

def _captions(value: Any) -> dict[str, str]:
    if not isinstance(value, dict):
        return {}
    return {k: v for k, v in value.items() if isinstance(v, str)}


class PreviewBody(BaseModel):
    caption: str = ""
    captions: dict[str, str] = {}
    mediaId: str | None = None


@router.post("/api/m/{model_id}/preview")
async def preview(model_id: str, body: PreviewBody) -> dict:
    _model(model_id)
    result = media.get_result(body.mediaId) if body.mediaId else None
    prefs = settings.get()["preferences"]
    out = {}
    for account in await model_accounts(model_id):
        text = body.captions.get(account["id"], body.caption)
        length = count_length(account["identifier"], text)
        problems, warnings = preflight(account, result, prefs)
        over = account["maxLength"] > 0 and length > account["maxLength"]
        out[account["id"]] = {
            "length": length,
            "max": account["maxLength"],
            "over": over,
            "willShorten": over and prefs["autoShorten"],
            "problems": [*problems, "Caption is too long for this network."] if over and not prefs["autoShorten"] else problems,
            "warnings": warnings,
        }
    return out


async def _send(account: dict, inp: dict, prefs: dict) -> dict:
    item = {
        "accountId": account["id"], "accountName": account["name"], "identifier": account["identifier"],
        "platform": platform_name(account["identifier"]), "picture": account.get("picture"),
        "postId": None, "rejected": None, "shortened": False, "sentAt": batches.iso(time.time()),
    }
    problems, _ = preflight(account, inp.get("media"), prefs)
    if problems:
        return {**item, "rejected": " ".join(problems)}
    try:
        body, shortened = build_post_request(account, inp, prefs, account["maxLength"])
        created = await postiz.create_post(body)
        post_id = created[0].get("postId") if isinstance(created, list) and created else None
        if not post_id:
            return {**item, "rejected": "The posting engine did not create the post."}
        return {**item, "postId": post_id, "shortened": shortened}
    except postiz.PostizError as exc:
        if exc.status < 500 and exc.status not in (401, 424):
            return {**item, "rejected": str(exc)}
        raise


def _schedule(value: Any) -> str | None:
    if value in (None, ""):
        return None
    ts = batches.parse_iso(value) if isinstance(value, str) else None
    if ts is None:
        raise HTTPException(400, "That date and time is not valid.")
    if ts < time.time() - 60:
        raise HTTPException(400, "Pick a time in the future.")
    return batches.iso(ts)


class PostBody(BaseModel):
    accountIds: list[str]
    caption: str = ""
    title: str = ""
    captions: dict[str, str] = {}
    mediaId: str | None = None
    scheduleAt: str | None = None


def _run_analytics_soon() -> None:
    task = asyncio.create_task(analytics.run_analytics())
    task.add_done_callback(lambda t: t.exception() if not t.cancelled() else None)


@router.post("/api/m/{model_id}/posts", status_code=201)
async def post(model_id: str, body: PostBody) -> dict:
    _model(model_id)
    if not body.accountIds:
        raise HTTPException(400, "Choose at least one account.")
    if len(body.caption) > 20000:
        raise HTTPException(400, "The caption is too long.")
    schedule = _schedule(body.scheduleAt)
    result = None
    if body.mediaId:
        result = media.get_result(body.mediaId)
        if not result:
            raise HTTPException(400, "The upload expired or is still processing — add the file again.")
    if not result and not body.caption.strip():
        raise HTTPException(400, "Add a video or write a caption.")
    mine = {a["id"]: a for a in await model_accounts(model_id)}
    chosen = [mine.get(i) for i in body.accountIds]
    if not all(chosen):
        raise HTTPException(400, "Some accounts aren't this model's anymore — refresh the page.")
    prefs = settings.get()["preferences"]
    inp = {"caption": body.caption, "title": body.title.strip(), "captions": _captions(body.captions),
           "media": result, "mediaName": (result or {}).get("name"), "scheduleAt": schedule}
    items = await asyncio.gather(*(_send(a, inp, prefs) for a in chosen if a))
    batch = batches.create(model_id, {"caption": body.caption, "title": body.title.strip(),
                                      "captions": inp["captions"], "media": result, "scheduleAt": schedule,
                                      "items": list(items)})
    _run_analytics_soon()
    return batches.with_status(batch, None, [])


async def live_status(items: list[dict]) -> list[dict]:
    window = batches.posts_window(items)
    if not window:
        return []
    posts = await postiz.list_posts(*window)
    by_id = {p.get("id"): p for p in posts}
    any_error = any(by_id.get(i.get("postId"), {}).get("state") == "ERROR" for b in items for i in b.get("items", []))
    notes: list[dict] = []
    if any_error:
        try:
            notes = await postiz.notifications()
        except postiz.PostizError:
            notes = []
    return [batches.with_status(b, by_id, notes) for b in items]


@router.get("/api/m/{model_id}/batches")
async def list_batches(model_id: str, limit: int = 30) -> list[dict]:
    _model(model_id)
    return await live_status(batches.list_for(model_id, min(max(limit, 1), 200)))


def _batch(model_id: str, batch_id: str) -> dict:
    batch = batches.get(batch_id, model_id)
    if not batch:
        raise HTTPException(404, "Not found.")
    return batch


@router.get("/api/m/{model_id}/batches/{batch_id}")
async def get_batch(model_id: str, batch_id: str) -> dict:
    return (await live_status([_batch(model_id, batch_id)]))[0]


_retrying: set[str] = set()


@router.post("/api/m/{model_id}/batches/{batch_id}/retry")
async def retry(model_id: str, batch_id: str) -> dict:
    batch = _batch(model_id, batch_id)
    if batch_id in _retrying:
        raise HTTPException(409, "Already retrying this post.")
    _retrying.add(batch_id)
    try:
        current = (await live_status([batch]))[0]
        failed = [i for i in current["items"] if i["state"] == "failed"]
        if not failed:
            return current
        mine = {a["id"]: a for a in await model_accounts(model_id)}
        prefs = settings.get()["preferences"]
        scheduled = batches.parse_iso(batch.get("scheduleAt"))
        inp = {**batch, "mediaName": (batch.get("media") or {}).get("name"),
               "scheduleAt": batch.get("scheduleAt") if scheduled and scheduled > time.time() else None}

        async def again(old: dict) -> dict:
            account = mine.get(old["accountId"])
            if not account:
                return {**old, "rejected": "This account isn't this model's anymore.", "postId": None}
            if old.get("postId"):
                try:
                    await postiz.delete_post(old["postId"])
                except postiz.PostizError:
                    pass
            return await _send(account, inp, prefs)

        retried = await asyncio.gather(*(again(i) for i in failed))
        by_account = {r["accountId"]: r for r in retried}
        clean = [{k: v for k, v in item.items() if k not in ("state", "error", "url")} for item in batch["items"]]
        batch["items"] = [by_account.get(i["accountId"], i) for i in clean]
        batches.save(batch)
        _run_analytics_soon()
        return (await live_status([batch]))[0]
    finally:
        _retrying.discard(batch_id)


@router.delete("/api/m/{model_id}/batches/{batch_id}")
async def delete_batch(model_id: str, batch_id: str) -> dict:
    batch = _batch(model_id, batch_id)

    async def drop(post_id: str) -> None:
        try:
            await postiz.delete_post(post_id)
        except postiz.PostizError:
            pass

    await asyncio.gather(*(drop(i["postId"]) for i in batch.get("items", []) if i.get("postId")))
    batches.remove(batch_id)
    return {"ok": True}


# ---------------------------------------------------------------- analytics

PERIODS = {7, 30, 90}


def _period(days: int) -> int:
    return days if days in PERIODS else 30


@router.get("/api/m/{model_id}/analytics")
async def get_analytics(model_id: str, days: int = 30) -> dict:
    _model(model_id)
    return analytics.overview(await model_accounts(model_id), _period(days))


@router.get("/api/m/{model_id}/analytics/videos/{post_id}")
async def video(model_id: str, post_id: str) -> dict:
    _model(model_id)
    detail = analytics.video_detail(post_id, await model_accounts(model_id))
    if not detail:
        raise HTTPException(404, "Not found.")
    return detail


_last_refresh: dict[str, float] = {}


@router.post("/api/m/{model_id}/analytics/refresh")
async def refresh(model_id: str, days: int = 30) -> dict:
    _model(model_id)
    mine = await model_accounts(model_id)
    if time.time() - _last_refresh.get(model_id, 0) > 60:
        _last_refresh[model_id] = time.time()
        analytics.mark_due([a["id"] for a in mine])
    try:
        await asyncio.wait_for(analytics.run_analytics(accounts=await load_accounts()), timeout=25)
    except Exception:  # noqa: BLE001 - show what we have
        pass
    return analytics.overview(mine, _period(days))


__all__ = ["router", "load_accounts", "DEFAULT_PREFERENCES"]
