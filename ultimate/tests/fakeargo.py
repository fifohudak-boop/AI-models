"""A stand-in for ArgoLink's OpenAI-style image API: synchronous POST /v1/images/generations
(returns a URL) and /v1/images/edits (returns base64), plus GET /v1/models for the key check — and
its async video API: POST /v1/videos/generations → poll GET /v1/videos/{id} (url in video.url)."""

from __future__ import annotations

import base64
import json

import httpx

GOOD_KEY = "argo-test-good"
IMAGE_URL = "https://cdn.argolink.io/out/{n}.png"
PNG_BYTES = b"\x89PNG\r\n\x1a\n an argolink image"
MP4_BYTES = b"\x00\x00\x00\x18ftypmp42 an argolink video"


class FakeArgoLink:
    def __init__(self) -> None:
        self.hosts: list[str] = []
        self.generations: list[dict] = []
        self.edits: list[dict] = []
        self.videos: dict[str, dict] = {}
        self.uploads: list[dict] = []  # media/uploads tickets requested

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handle)

    @staticmethod
    def _json(status: int, data: dict) -> httpx.Response:
        return httpx.Response(status, json=data)

    def handle(self, request: httpx.Request) -> httpx.Response:
        url = request.url
        if url.host.startswith("cdn.argolink"):
            body = MP4_BYTES if url.path.endswith(".mp4") else PNG_BYTES
            return httpx.Response(200, content=body, headers={"Content-Type": "application/octet-stream"})
        if url.host.startswith("up.argolink"):  # the presigned PUT target (no auth)
            return httpx.Response(200)
        self.hosts.append(url.host)
        if request.headers.get("Authorization") != f"Bearer {GOOD_KEY}":
            return self._json(401, {"error": {"message": "Invalid API key", "code": "invalid_api_key"}})
        path = url.path
        if path == "/v1/models" and request.method == "GET":
            return self._json(200, {"data": [{"id": "nano-banana-pro"}]})
        if path == "/v1/images/generations" and request.method == "POST":
            self.generations.append(json.loads(request.content))
            n = len(self.generations)
            return self._json(200, {"created": 1, "data": [{"url": IMAGE_URL.format(n=n)}]})
        if path == "/v1/images/edits" and request.method == "POST":
            self.edits.append(json.loads(request.content))
            # exercise the base64 path
            return self._json(200, {"created": 1, "data": [{"b64_json": base64.b64encode(PNG_BYTES).decode()}]})
        # ---- media uploads (hosted references for video edit) ----
        if path == "/v1/media/uploads" and request.method == "POST":
            self.uploads.append(json.loads(request.content))
            n = len(self.uploads)
            return self._json(200, {"upload_url": f"https://up.argolink.io/u/{n}",
                                    "media_url": f"https://media.argolink.io/m/{n}"})
        # ---- async video ----
        if path == "/v1/videos/generations" and request.method == "POST":
            rid = f"argo-vid-{len(self.videos) + 1}"
            self.videos[rid] = {"body": json.loads(request.content)}
            return self._json(200, {"request_id": rid, "status": "pending"})
        # The finished clip is served from ArgoLink's OWN authenticated API endpoint, which needs the
        # key just like every call above (the top-level auth check already enforced it) — fetching it
        # without the Bearer token is the real-world 401. Must come before the generic poll route.
        if path.startswith("/v1/videos/") and path.endswith("/content") and request.method == "GET":
            return httpx.Response(200, content=MP4_BYTES, headers={"Content-Type": "video/mp4"})
        if path.startswith("/v1/videos/") and request.method == "GET":
            rid = path.rsplit("/", 1)[-1]
            return self._json(200, {"status": "done",
                                    "video": {"url": f"https://argolink.io/v1/videos/{rid}/content"}})
        return self._json(404, {"error": {"message": f"no route {request.method} {path}"}})
