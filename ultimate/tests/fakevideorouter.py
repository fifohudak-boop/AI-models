"""A stand-in for VideoRouter's async video API: GET /api/v1/models (key check), POST /api/v1/videos
to create a job, then GET /api/v1/videos/{id} to poll (status queued → in_progress → completed)."""

from __future__ import annotations

import json

import httpx

GOOD_KEY = "llmr_sk_live_test_good"
RESULT_URL = "https://cdn.videorouter.sh/out/{task}.mp4"


class FakeVideoRouter:
    def __init__(self) -> None:
        self.hosts: list[str] = []
        self.jobs: dict[str, dict] = {}
        self.video_bytes = b"\x00\x00\x00\x18ftypmp42 a videorouter video"

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handle)

    @staticmethod
    def _json(status: int, data: dict) -> httpx.Response:
        return httpx.Response(status, json=data)

    def handle(self, request: httpx.Request) -> httpx.Response:
        url = request.url
        if url.host.startswith("cdn.videorouter"):
            return httpx.Response(200, content=self.video_bytes, headers={"Content-Type": "video/mp4"})
        self.hosts.append(url.host)
        if request.headers.get("Authorization") != f"Bearer {GOOD_KEY}":
            return self._json(401, {"error": {"message": "Invalid API key", "code": "invalid_api_key"}})
        path = url.path
        if path == "/api/v1/models" and request.method == "GET":
            return self._json(200, {"data": [{"id": "bytedance/seedance-2.5/fal"}]})
        if path == "/api/v1/videos" and request.method == "POST":
            body = json.loads(request.content)
            task = f"video_{len(self.jobs) + 1}"
            self.jobs[task] = {"body": body, "polls": 0}
            return self._json(200, {"id": task, "status": "queued"})
        if path.startswith("/api/v1/videos/") and request.method == "GET":
            task = path[len("/api/v1/videos/"):]
            if task not in self.jobs:
                return self._json(404, {"error": {"message": "job not found"}})
            info = self.jobs[task]
            info["polls"] += 1
            if info["polls"] == 1:
                return self._json(200, {"id": task, "status": "in_progress"})
            return self._json(200, {"id": task, "status": "completed",
                                    "data": [{"url": RESULT_URL.format(task=task)}]})
        return self._json(404, {"error": {"message": f"no route {request.method} {path}"}})
