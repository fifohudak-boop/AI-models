"""A stand-in for WaveSpeed's API: POST /api/v3/{model-path} to create a prediction, then
GET /api/v3/predictions/{id}/result to poll (status created → processing → completed)."""

from __future__ import annotations

import json

import httpx

GOOD_KEY = "ws-test-good"
RESULT_URL = "https://cdn.wavespeed.ai/outputs/{task}.mp4"


class FakeWaveSpeed:
    def __init__(self) -> None:
        self.hosts: list[str] = []
        self.tasks: dict[str, dict] = {}
        self.video_bytes = b"\x00\x00\x00\x18ftypmp42 a wavespeed video"

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handle)

    @staticmethod
    def _json(status: int, data: dict) -> httpx.Response:
        return httpx.Response(status, json=data)

    def handle(self, request: httpx.Request) -> httpx.Response:
        url = request.url
        if url.host.startswith("cdn.wavespeed"):
            return httpx.Response(200, content=self.video_bytes, headers={"Content-Type": "video/mp4"})
        self.hosts.append(url.host)
        if request.headers.get("Authorization") != f"Bearer {GOOD_KEY}":
            return self._json(401, {"code": 401, "message": "Unauthorized"})
        path = url.path
        if path.startswith("/api/v3/predictions/") and path.endswith("/result") and request.method == "GET":
            task = path[len("/api/v3/predictions/"):-len("/result")]
            if task == "connectivity-check":
                return self._json(404, {"code": 404, "message": "prediction not found"})
            if task not in self.tasks:
                return self._json(404, {"code": 404, "message": "prediction not found"})
            info = self.tasks[task]
            info["polls"] += 1
            if info["polls"] == 1:
                return self._json(200, {"code": 200, "data": {"id": task, "status": "processing", "outputs": []}})
            return self._json(200, {"code": 200, "data": {"id": task, "status": "completed",
                                                          "outputs": [RESULT_URL.format(task=task)], "error": ""}})
        if path.startswith("/api/v3/") and request.method == "POST":
            model_path = path[len("/api/v3/"):]
            body = json.loads(request.content)
            task = f"ws-{len(self.tasks) + 1}"
            self.tasks[task] = {"model_path": model_path, "body": body, "polls": 0}
            return self._json(200, {"code": 200, "data": {"id": task, "status": "created",
                                                          "urls": {"get": f"/api/v3/predictions/{task}/result"}}})
        return self._json(404, {"code": 404, "message": f"no route {request.method} {path}"})
