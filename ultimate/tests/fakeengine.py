"""A small stand-in for the posting engine (Postiz's public API), for tests."""

from __future__ import annotations

import json
import time
from datetime import datetime, timezone

import httpx

KEY = "test-engine-key"


def now_iso(offset_s: float = 0) -> str:
    return datetime.fromtimestamp(time.time() + offset_s, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


class FakeEngine:
    def __init__(self) -> None:
        self.integrations = [
            {"id": "ig1", "name": "Mia IG", "identifier": "instagram-standalone", "picture": None, "profile": "mia", "disabled": False},
            {"id": "tt1", "name": "Mia TikTok", "identifier": "tiktok", "picture": None, "profile": "miatok", "disabled": False},
            {"id": "x1", "name": "Shared X", "identifier": "x", "picture": None, "profile": "shared", "disabled": False},
        ]
        self.posts: dict[str, dict] = {}
        self.uploads: list[str] = []
        self.created: list[dict] = []
        self.next_post = 1
        self.reject_next = False

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handle)

    def handle(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/api/auth/login":
            body = json.loads(request.content)
            if body.get("password") != "postiz-password":
                return httpx.Response(400, json={"msg": "bad"})
            return httpx.Response(200, json={"login": True}, headers={"set-cookie": "auth=JWT1; Path=/; Secure"})
        if path == "/api/user/self":
            return httpx.Response(200, json={"publicApi": KEY}) if request.headers.get("auth") == "JWT1" else httpx.Response(401)
        if not path.startswith("/api/public/v1"):
            return httpx.Response(404, json={"msg": "nope"})
        if request.headers.get("authorization") != KEY:
            return httpx.Response(401, json={"msg": "bad key"})
        p = path[len("/api/public/v1"):]
        if p == "/is-connected":
            return httpx.Response(200, json={"connected": True})
        if p == "/integrations":
            return httpx.Response(200, json=self.integrations)
        if p.startswith("/integration-settings/"):
            ident = next((i["identifier"] for i in self.integrations if i["id"] == p.rsplit("/", 1)[1]), "")
            return httpx.Response(200, json={"output": {"maxLength": 280 if ident == "x" else 2200}})
        if p.startswith("/social/"):
            provider = p.rsplit("/", 1)[1]
            if provider == "youtube":
                return httpx.Response(400, json={"msg": "Provider not configured"})
            return httpx.Response(200, json={"url": f"https://auth.example.com/{provider}?state=abc"})
        if p == "/upload" and request.method == "POST":
            n = len(self.uploads) + 1
            self.uploads.append(f"u{n}")
            return httpx.Response(200, json={"id": f"u{n}", "path": f"https://engine.example.com/uploads/u{n}.bin"})
        if p == "/posts" and request.method == "POST":
            body = json.loads(request.content)
            self.created.append(body)
            if self.reject_next:
                self.reject_next = False
                return httpx.Response(400, json={"msg": "Video too long for this network"})
            pid = f"p{self.next_post}"
            self.next_post += 1
            self.posts[pid] = {"id": pid, "publishDate": now_iso(-60), "state": "PUBLISHED",
                               "releaseURL": f"https://example.com/{pid}", "releaseId": f"r{pid}",
                               "integration": {"id": body["posts"][0]["integration"]["id"]}}
            return httpx.Response(200, json=[{"postId": pid, "integration": body["posts"][0]["integration"]["id"]}])
        if p == "/posts" and request.method == "GET":
            return httpx.Response(200, json={"posts": list(self.posts.values())})
        if p.startswith("/posts/") and request.method == "DELETE":
            self.posts.pop(p.rsplit("/", 1)[1], None)
            return httpx.Response(200, json={"ok": True})
        if p.startswith("/analytics/post/"):
            pid = p.rsplit("/", 1)[1]
            if pid not in self.posts:
                return httpx.Response(200, json=[])
            day = now_iso()[:10]
            return httpx.Response(200, json=[{"label": "Views", "data": [{"total": "120", "date": day}]},
                                             {"label": "Likes", "data": [{"total": "7", "date": day}]}])
        if p.startswith("/analytics/"):
            return httpx.Response(200, json=[{"label": "Followers", "data": [{"total": "1500", "date": now_iso()[:10]}]}])
        if p.startswith("/notifications"):
            return httpx.Response(200, json={"notifications": []})
        if p.startswith("/integration-trigger/"):
            return httpx.Response(200, json={"output": [{"id": "111", "name": "Board"}]})
        return httpx.Response(404, json={"msg": "unknown"})
