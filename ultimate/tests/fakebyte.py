"""A stand-in for ByteDance's BytePlus ModelArk API: the Seedance video task API
(contents/generations/tasks) and the synchronous Seedream image API (images/generations)."""

from __future__ import annotations

import json

import httpx

GOOD_KEY = "byte-test-good"
VIDEO_URL = "https://byteplus-result-test.tos-ap-southeast-1.bytepluses.com/out/{task}.mp4"
IMAGE_URL = "https://byteplus-result-test.tos-ap-southeast-1.bytepluses.com/out/{n}.png"


class FakeByteDance:
    def __init__(self) -> None:
        self.hosts: list[str] = []
        self.video_tasks: dict[str, dict] = {}
        self.image_calls: list[dict] = []
        self.video_bytes = b"\x00\x00\x00\x18ftypmp42 a seedance video"
        self.image_bytes = b"\x89PNG\r\n\x1a\n a seedream image"

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handle)

    @staticmethod
    def _json(status: int, data: dict) -> httpx.Response:
        return httpx.Response(status, json=data)

    def handle(self, request: httpx.Request) -> httpx.Response:
        url = request.url
        if url.host.startswith("byteplus-result-test"):
            if str(url).endswith(".mp4"):
                return httpx.Response(200, content=self.video_bytes, headers={"Content-Type": "video/mp4"})
            return httpx.Response(200, content=self.image_bytes, headers={"Content-Type": "image/png"})
        self.hosts.append(url.host)
        if request.headers.get("Authorization") != f"Bearer {GOOD_KEY}":
            return self._json(401, {"error": {"code": "AuthenticationError", "message": "The API key is invalid."}})
        path = url.path
        if path == "/api/v3/images/generations" and request.method == "POST":
            body = json.loads(request.content)
            if body.get("model") == "connectivity-check":  # the key check: reachable, model just doesn't exist
                return self._json(400, {"error": {"code": "InvalidParameter", "message": "model not found"}})
            self.image_calls.append(body)
            n = len(self.image_calls)
            return self._json(200, {"model": body.get("model"), "created": 1,
                                    "data": [{"url": IMAGE_URL.format(n=n), "size": body.get("size")}],
                                    "usage": {"generated_images": 1, "output_tokens": 100, "total_tokens": 100}})
        if path == "/api/v3/contents/generations/tasks" and request.method == "POST":
            body = json.loads(request.content)
            task = f"vtask-{len(self.video_tasks) + 1}"
            self.video_tasks[task] = {"body": body, "polls": 0}
            return self._json(200, {"id": task, "status": "queued"})
        if path.startswith("/api/v3/contents/generations/tasks/") and request.method == "GET":
            task = path.rsplit("/", 1)[1]
            if task not in self.video_tasks:
                return self._json(404, {"error": {"code": "NotFound", "message": "task not found"}})
            info = self.video_tasks[task]
            info["polls"] += 1
            if info["polls"] == 1:
                return self._json(200, {"id": task, "status": "running"})
            return self._json(200, {"id": task, "status": "succeeded",
                                    "content": {"video_url": VIDEO_URL.format(task=task)},
                                    "usage": {"total_tokens": 108000}})
        return self._json(404, {"error": {"code": "NotFound", "message": f"no route {request.method} {path}"}})
