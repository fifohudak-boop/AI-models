"""A stand-in for Alibaba Cloud Model Studio's Wan 3.0 video API, as its documentation describes it:
temporary uploads (getPolicy → OSS form upload → oss://), async video-synthesis tasks and task queries."""

from __future__ import annotations

import json
from urllib.parse import parse_qs

import httpx

GOOD_KEY = "sk-test-good"
UPLOAD_HOST = "https://dashscope-file-test.oss-ap-southeast-1.aliyuncs.com"
RESULT_URL = "https://dashscope-result-test.oss-ap-southeast-1.aliyuncs.com/out/{task}.mp4"


class FakeWan:
    def __init__(self) -> None:
        self.hosts: list[str] = []
        self.policies: list[str] = []  # the model each upload policy was asked for
        self.uploads: dict[str, bytes] = {}  # oss key → file
        self.upload_fields: list[list[str]] = []  # the form fields' order, per upload
        self.tasks: dict[str, dict] = {}  # task id → {"body", "headers", "polls"}
        self.result = b"\x00\x00\x00\x18ftypmp42 a finished video"
        self.fail_next_task: str | None = None

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handle)

    @staticmethod
    def _json(status: int, data: dict) -> httpx.Response:
        return httpx.Response(status, json=data)

    def handle(self, request: httpx.Request) -> httpx.Response:
        url = request.url
        if str(url).startswith(UPLOAD_HOST):
            return self._oss_upload(request)
        if url.host.startswith("dashscope-result-test"):
            return httpx.Response(200, content=self.result, headers={"Content-Type": "video/mp4"})
        self.hosts.append(url.host)
        if request.headers.get("Authorization") != f"Bearer {GOOD_KEY}":
            return self._json(401, {"code": "InvalidApiKey", "message": "Invalid API-key provided.", "request_id": "r"})
        path = url.path
        if path == "/api/v1/uploads":
            params = parse_qs(url.query.decode())
            if params.get("action") != ["getPolicy"] or not params.get("model"):
                return self._json(400, {"code": "InvalidParameter", "message": "action and model are required"})
            self.policies.append(params["model"][0])
            return self._json(200, {"request_id": "r", "data": {
                "policy": "eyJleHBpcmF0aW9uIjoi", "signature": "c2lnbmF0dXJl", "upload_dir": "dashscope-instant/abc/2026-10-13/xyz",
                "upload_host": UPLOAD_HOST, "expire_in_seconds": 300, "max_file_size_mb": 100, "capacity_limit_mb": 999999,
                "oss_access_key_id": "LTAI-test", "x_oss_object_acl": "private", "x_oss_forbid_overwrite": "true"}})
        if path == "/api/v1/services/aigc/video-generation/video-synthesis" and request.method == "POST":
            if request.headers.get("X-DashScope-Async") != "enable":
                return self._json(400, {"code": "AccessDenied", "message": "current user api does not support synchronous calls"})
            body = json.loads(request.content)
            urls = [m["url"] for m in body.get("input", {}).get("media", [])]
            if any(u.startswith("oss://") for u in urls) and request.headers.get("X-DashScope-OssResourceResolve") != "enable":
                return self._json(400, {"code": "InvalidParameter", "message": "url error, please check url!"})
            if any(u.startswith("oss://") and u[len("oss://"):] not in self.uploads for u in urls):
                return self._json(400, {"code": "InvalidParameter", "message": "The provided URL does not appear to be valid."})
            task = f"task-{len(self.tasks) + 1}"
            self.tasks[task] = {"body": body, "headers": dict(request.headers), "polls": 0}
            return self._json(200, {"request_id": "r", "output": {"task_id": task, "task_status": "PENDING"}})
        if path.startswith("/api/v1/tasks/"):
            task = path.rsplit("/", 1)[1]
            if task not in self.tasks:
                return self._json(400, {"code": "InvalidParameter", "message": "task_id is invalid", "request_id": "r"})
            info = self.tasks[task]
            info["polls"] += 1
            if self.fail_next_task == task:
                return self._json(200, {"request_id": "r", "output": {
                    "task_id": task, "task_status": "FAILED", "code": "DataInspectionFailed",
                    "message": "Input data may contain inappropriate content."}})
            if info["polls"] == 1:
                return self._json(200, {"request_id": "r", "output": {"task_id": task, "task_status": "RUNNING"}})
            return self._json(200, {"request_id": "r", "output": {
                "task_id": task, "task_status": "SUCCEEDED", "video_url": RESULT_URL.format(task=task),
                "orig_prompt": info["body"]["input"].get("prompt", "")},
                "usage": {"video_count": 1, "output_video_duration": info["body"]["parameters"].get("duration"), "SR": 720}})
        return self._json(404, {"code": "NotFound", "message": f"no route {request.method} {path}"})

    def _oss_upload(self, request: httpx.Request) -> httpx.Response:
        content_type = request.headers.get("Content-Type", "")
        boundary = content_type.split("boundary=")[-1].encode()
        fields: list[str] = []
        values: dict[str, bytes] = {}
        for part in request.content.split(b"--" + boundary):
            if b"Content-Disposition" not in part:
                continue
            head, _, data = part.partition(b"\r\n\r\n")
            name = head.split(b'name="', 1)[1].split(b'"', 1)[0].decode()
            fields.append(name)
            values[name] = data[:-2] if data.endswith(b"\r\n") else data
        self.upload_fields.append(fields)
        required = ["OSSAccessKeyId", "Signature", "policy", "x-oss-object-acl", "x-oss-forbid-overwrite", "key"]
        if any(f not in fields for f in required) or fields[-1] != "file":
            return httpx.Response(400, text="<Error><Code>InvalidArgument</Code></Error>")
        self.uploads[values["key"].decode()] = values["file"]
        return httpx.Response(200)
