"""A stand-in for ArgoLink's OpenAI-style image API: synchronous POST /v1/images/generations
(returns a URL) and /v1/images/edits (returns base64), plus GET /v1/models for the key check."""

from __future__ import annotations

import base64
import json

import httpx

GOOD_KEY = "argo-test-good"
IMAGE_URL = "https://cdn.argolink.io/out/{n}.png"
PNG_BYTES = b"\x89PNG\r\n\x1a\n an argolink image"


class FakeArgoLink:
    def __init__(self) -> None:
        self.hosts: list[str] = []
        self.generations: list[dict] = []
        self.edits: list[dict] = []

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handle)

    @staticmethod
    def _json(status: int, data: dict) -> httpx.Response:
        return httpx.Response(status, json=data)

    def handle(self, request: httpx.Request) -> httpx.Response:
        url = request.url
        if url.host.startswith("cdn.argolink"):
            return httpx.Response(200, content=PNG_BYTES, headers={"Content-Type": "image/png"})
        self.hosts.append(url.host)
        if request.headers.get("Authorization") != f"Bearer {GOOD_KEY}":
            return self._json(401, {"error": {"message": "Invalid API key", "code": "invalid_api_key"}})
        path = url.path
        if path == "/v1/models" and request.method == "GET":
            return self._json(200, {"data": [{"id": "seedream-5.0-pro"}]})
        if path == "/v1/images/generations" and request.method == "POST":
            self.generations.append(json.loads(request.content))
            n = len(self.generations)
            return self._json(200, {"created": 1, "data": [{"url": IMAGE_URL.format(n=n)}]})
        if path == "/v1/images/edits" and request.method == "POST":
            self.edits.append(json.loads(request.content))
            # exercise the base64 path
            return self._json(200, {"created": 1, "data": [{"b64_json": base64.b64encode(PNG_BYTES).decode()}]})
        return self._json(404, {"error": {"message": f"no route {request.method} {path}"}})
