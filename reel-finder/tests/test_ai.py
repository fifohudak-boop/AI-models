import asyncio
import base64
import json

import httpx

from reelfinder.ai import KeywordBrain, OllamaBrain, parse_json_object, pick_brain, sees_images
from reelfinder.models import Candidate


def run(coro):
    return asyncio.run(coro)


def cand(caption="Night drift session 🔥 #cardrift #jdm", **kw):
    return Candidate(platform="tiktok", id="1", url="u", caption=caption, author="dk", views=1000, duration=14, **kw)


class FakeOllama:
    """A stand-in for Ollama's HTTP API that records what Reel Finder sends."""

    def __init__(self, replies, models=("qwen3-vl:8b",), reject_think=False, reject_images=False):
        self.replies = list(replies)
        self.models = models
        self.reject_think = reject_think
        self.reject_images = reject_images
        self.requests = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/tags":
            return httpx.Response(200, json={"models": [{"name": m} for m in self.models]})
        body = json.loads(request.content)
        self.requests.append(body)
        if self.reject_think and "think" in body:
            return httpx.Response(400, json={"error": '"qwen" does not support thinking'})
        if self.reject_images and body["messages"][0].get("images"):
            return httpx.Response(500, json={"error": "this model is missing data required for image input"})
        return httpx.Response(200, json={"message": {"role": "assistant", "content": self.replies.pop(0)}})

    def transport(self):
        return httpx.MockTransport(self)


def test_parse_json_object_variants():
    assert parse_json_object('{"score": 80, "reason": "ok"}') == {"score": 80, "reason": "ok"}
    assert parse_json_object('```json\n{"score": 5}\n```') == {"score": 5}
    assert parse_json_object('<think>hmm {"x":1}</think> Sure! {"score": 9, "reason": "r"} done') == {"score": 9, "reason": "r"}
    assert parse_json_object("no json here") == {}
    assert parse_json_object("[1, 2]") == {}


def test_ollama_judge_sends_image_schema_and_clamps():
    fake = FakeOllama(['{"score": 140, "reason": "Exactly a night drift with smoke"}'])
    brain = OllamaBrain("qwen3-vl:8b", "http://ollama.test", transport=fake.transport())
    verdict = run(brain.judge("night car drifts", "", cand(), b"JPEGDATA"))
    assert verdict.score == 100 and "night drift" in verdict.reason
    sent = fake.requests[0]
    assert sent["model"] == "qwen3-vl:8b" and sent["stream"] is False and sent["think"] is False
    assert sent["format"]["required"] == ["score", "reason"]
    assert sent["messages"][0]["images"] == [base64.b64encode(b"JPEGDATA").decode()]
    assert "night car drifts" in sent["messages"][0]["content"]


def test_ollama_retries_without_think_and_without_images():
    fake = FakeOllama(['{"score": 61, "reason": "related"}'], reject_think=True, reject_images=True)
    brain = OllamaBrain("llama3.1:8b", "http://ollama.test", transport=fake.transport())
    verdict = run(brain.judge("drifts", "", cand(), b"IMG"))
    assert verdict.score == 61
    assert brain.can_see is False and brain._send_think is False
    assert "think" not in fake.requests[-1] and "images" not in fake.requests[-1]["messages"][0]


def test_ollama_plan_dedupes_and_limits():
    reply = json.dumps({"tiktok": ["night drift", "Night Drift", "#cardrift", "drift smoke", "jdm night", "x", "y", "z"],
                        "instagram": ["#nightdrift"]})
    fake = FakeOllama([reply])
    brain = OllamaBrain("qwen3-vl:8b", "http://ollama.test", transport=fake.transport())
    plan = run(brain.plan_queries("night car drifts", "", ["tiktok", "instagram"], 6))
    assert plan["tiktok"] == ["night drift", "#cardrift", "drift smoke", "jdm night", "x", "y"]
    assert plan["instagram"] == ["#nightdrift"]


def test_pick_brain_fallbacks():
    fake = FakeOllama([], models=("gemma3:4b",))
    brain, warning = run(pick_brain("qwen3-vl:8b", "http://ollama.test", transport=fake.transport()))
    assert isinstance(brain, KeywordBrain) and "isn't installed" in warning
    brain, warning = run(pick_brain("gemma3:4b", "http://ollama.test", transport=fake.transport()))
    assert isinstance(brain, OllamaBrain) and warning is None
    brain, warning = run(pick_brain("qwen3-vl:8b", "http://127.0.0.1:9"))  # nothing listening
    assert isinstance(brain, KeywordBrain) and "isn't running" in warning


def test_keyword_brain():
    brain = KeywordBrain()
    plan = run(brain.plan_queries("cinematic night car drift with smoke", "#cardrift, jdm", ["tiktok"], 6))
    assert plan["tiktok"][:2] == ["#cardrift", "jdm"]
    assert len(plan["tiktok"]) <= 6
    good = run(brain.judge("night car drift", "", cand(), None))
    bad = run(brain.judge("night car drift", "", cand(caption="my cat eating breakfast"), None))
    assert good.score >= 70 > bad.score
    assert "drift" in good.reason


def test_sees_images():
    assert sees_images("qwen3-vl:8b") and sees_images("gemma3:4b") and sees_images("llava:7b")
    assert not sees_images("llama3.1:8b") and not sees_images("gemma3:1b")


def test_thinking_model_is_flagged_and_empty_answers_raise():
    class Thinker(FakeOllama):
        def __call__(self, request):
            if request.url.path == "/api/chat":
                self.requests.append(json.loads(request.content))
                return httpx.Response(200, json={"message": {"content": "", "thinking": "<think>hmm, let me see"}})
            return super().__call__(request)

    fake = Thinker([])
    brain = OllamaBrain("qwen3-vl:2b", "http://ollama.test", transport=fake.transport())
    try:
        run(brain.judge("drifts", "", cand(), None))
        raise AssertionError("expected an error")
    except ValueError:
        pass
    assert brain.thinks is True
    assert fake.requests[0]["options"]["num_predict"] > 0  # a rambling model can't stall the hunt
