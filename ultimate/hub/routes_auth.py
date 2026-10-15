"""Logging in, logging out, and (for the owner) inviting people and giving them models."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel

from . import auth, personas

router = APIRouter()


def _secure(request: Request) -> bool:
    if request.url.scheme == "https":
        return True
    forwarded = request.headers.get("x-forwarded-proto", "").split(",")[0].strip().lower()
    return forwarded == "https"


def _set_cookie(request: Request, response: Response, token: str) -> None:
    response.set_cookie(
        auth.COOKIE, token, max_age=auth.SESSION_TTL, httponly=True,
        samesite="lax", secure=_secure(request), path="/",
    )


class LoginBody(BaseModel):
    username: str
    password: str


@router.post("/api/auth/login")
async def login(body: LoginBody, request: Request, response: Response) -> dict:
    user = auth.verify(body.username, body.password)
    if not user:
        raise HTTPException(401, "Wrong username or password.")
    _set_cookie(request, response, auth.start_session(user["id"]))
    return {"user": {k: user[k] for k in ("id", "username", "name", "role")}}


@router.post("/api/auth/logout")
async def logout(request: Request, response: Response) -> dict:
    auth.end_session(request.cookies.get(auth.COOKIE) or "")
    response.delete_cookie(auth.COOKIE, path="/")
    return {"ok": True}


@router.get("/api/auth/me")
async def me(request: Request) -> dict:
    user = getattr(request.state, "user", None)
    if not user:
        raise HTTPException(401, "Please log in.")
    allowed = auth.allowed_models(user)
    return {
        "user": {"id": user["id"], "username": user.get("username", ""),
                 "name": user.get("name", ""), "role": user["role"]},
        "local": bool(user.get("local")),
        "canManage": user.get("role") == "owner",
        "models": None if allowed is None else sorted(allowed),
    }


# ---------------------------------------------------------------- owner: people

def _with_model_names(people: list[dict]) -> list[dict]:
    names = {p["id"]: p["name"] for p in personas.list_all()}
    for person in people:
        person["modelNames"] = [names.get(mid) or "—" for mid in person["models"]]
    return people


@router.get("/api/auth/users")
async def users() -> list[dict]:
    return _with_model_names(auth.list_users())


class UserBody(BaseModel):
    username: str
    password: str
    name: str = ""
    models: list[str] = []


@router.post("/api/auth/users", status_code=201)
async def add_user(body: UserBody) -> dict:
    for model_id in body.models:
        personas.require(model_id)
    try:
        created = auth.create_user(body.username, body.password, body.name, "guest", body.models)
    except auth.AuthError as exc:
        raise HTTPException(400, str(exc)) from exc
    return _with_model_names([created])[0]


class AccessBody(BaseModel):
    models: list[str]


@router.put("/api/auth/users/{user_id}/models")
async def set_user_models(user_id: str, body: AccessBody) -> dict:
    if not auth.get_user(user_id):
        raise HTTPException(404, "No such person.")
    for model_id in body.models:
        personas.require(model_id)
    auth.set_access(user_id, body.models)
    updated = auth.get_user(user_id)
    assert updated is not None
    return _with_model_names([updated])[0]


class PasswordBody(BaseModel):
    password: str


@router.put("/api/auth/users/{user_id}/password")
async def reset_user_password(user_id: str, body: PasswordBody) -> dict:
    try:
        auth.set_password(user_id, body.password)
    except auth.AuthError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {"ok": True}


@router.delete("/api/auth/users/{user_id}")
async def remove_user(user_id: str) -> dict:
    auth.delete_user(user_id)
    return {"ok": True}
