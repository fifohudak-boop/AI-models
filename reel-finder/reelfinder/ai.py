"""The AI brain: plans searches and judges videos with a local Ollama model.

`KeywordBrain` has the same interface and is used when Ollama isn't running, so a
hunt always works — it just matches words instead of understanding meaning.
"""

from __future__ import annotations

import base64
import json
import re
from dataclasses import dataclass

import httpx

from .config import OLLAMA_HOST
from .models import Candidate
from .parsing import split_terms

_STOPWORDS = set("""
a an and are as at be but by for from has have i in into is it its me my no not of on or our
so that the their them then there these this those to too very was we were what when where which
who with without you your video videos clip clips short shorts reel reels tiktok instagram want
need looking find some any like just only more most also really
""".split())

PLAN_SCHEMA = {
    "type": "object",
    "properties": {
        "tiktok": {"type": "array", "items": {"type": "string"}},
        "instagram": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["tiktok", "instagram"],
}

VERDICT_SCHEMA = {
    "type": "object",
    "properties": {"score": {"type": "integer"}, "reason": {"type": "string"}},
    "required": ["score", "reason"],
}


@dataclass
class Verdict:
    score: int
    reason: str


def _words(text: str) -> list[str]:
    return [w for w in re.findall(r"[a-z0-9]+", text.lower()) if w not in _STOPWORDS and len(w) > 1]


def _dedupe(queries: list[str], limit: int) -> list[str]:
    out: dict[str, str] = {}
    for q in queries:
        q = re.sub(r"\s+", " ", str(q)).strip().strip('"')
        if q and q.lower() not in out:
            out[q.lower()] = q
    return list(out.values())[:limit]


def _describe(c: Candidate) -> str:
    stats = []
    if c.duration:
        stats.append(f"{c.duration:.0f}s long")
    if c.views is not None:
        stats.append(f"{c.views:,} views")
    if c.likes is not None:
        stats.append(f"{c.likes:,} likes")
    return (
        f"Platform: {c.platform}\nCreator: @{c.author or 'unknown'}\n"
        f"Caption: {c.caption[:1200] or '(no caption)'}\n"
        f"Stats: {', '.join(stats) or 'unknown'}"
    )


class KeywordBrain:
    """No-AI fallback: plans from your keywords and scores by word overlap."""

    name = "keyword matching"
    can_see = False

    async def plan_queries(self, description: str, keywords: str, platforms: list[str], per_platform: int) -> dict[str, list[str]]:
        terms = split_terms(keywords)
        words = _words(description)
        base = terms + ([" ".join(words[:4])] if words else [])
        base += [" ".join(words[i:i + 2]) for i in range(0, max(len(words) - 1, 0), 2)]
        hashtags = ["#" + w for w in words[:4]]
        queries = _dedupe(base + hashtags, per_platform)
        return {p: list(queries) for p in platforms}

    async def judge(self, description: str, keywords: str, c: Candidate, image: bytes | None) -> Verdict:
        wanted = set(_words(description)) | {w for t in split_terms(keywords) for w in _words(t)}
        if not wanted:
            return Verdict(50, "No description to compare against")
        text = c.caption.lower()
        have = set(_words(c.caption))

        def mentioned(w: str) -> bool:  # "car" and "drift" both match #cardrift
            if w in have or (len(w) >= 4 and w in text):
                return True
            return len(w) >= 3 and any(h.startswith(w) or h.endswith(w) for h in have)

        hits = sorted(w for w in wanted if mentioned(w))
        must = [t for t in split_terms(keywords) if _words(t) and all(mentioned(w) for w in _words(t))]
        score = min(100, round(100 * len(hits) / max(2, min(len(wanted), 4))) + 15 * len(must))
        reason = f"Caption mentions: {', '.join(hits)}" if hits else "Caption doesn't mention what you asked for"
        return Verdict(score, reason)

    async def verify_frames(self, description: str, frames: list[bytes]) -> Verdict:
        return Verdict(100, "Watch-check needs the AI model")


class OllamaBrain:
    """Uses a local Ollama model (ideally one that can see images, e.g. qwen3-vl or gemma3)."""

    def __init__(self, model: str, host: str = OLLAMA_HOST, timeout: float = 180,
                 transport: httpx.AsyncBaseTransport | None = None):
        self.model = model
        self.transport = transport
        self.name = model
        self.host = host.rstrip("/")
        self.timeout = timeout
        self.can_see = True
        self.thinks = False  # set when the model reasons at length before answering (slow)
        self._send_think = True

    async def _chat(self, prompt: str, schema: dict, images: list[bytes] | None = None, max_tokens: int = 300) -> dict:
        message: dict = {"role": "user", "content": prompt}
        if images and self.can_see:
            message["images"] = [base64.b64encode(img).decode() for img in images]
        payload: dict = {
            "model": self.model,
            "messages": [message],
            "stream": False,
            "format": schema,
            # A cap keeps a rambling model from stalling the hunt; answers need far fewer tokens.
            "options": {"temperature": 0, "num_predict": max_tokens},
        }
        if self._send_think:
            payload["think"] = False
        async with httpx.AsyncClient(timeout=self.timeout, transport=self.transport) as client:
            resp = await client.post(f"{self.host}/api/chat", json=payload)
            if resp.status_code >= 400:
                text = resp.text.lower()
                if "think" in text and self._send_think:
                    self._send_think = False
                    return await self._chat(prompt, schema, images)
                if "image" in text and images and self.can_see:
                    # Text-only model: carry on with captions alone.
                    self.can_see = False
                    return await self._chat(prompt, schema, None, max_tokens)
                resp.raise_for_status()
            message = resp.json().get("message", {})
        if message.get("thinking"):
            self.thinks = True
        data = parse_json_object(message.get("content", ""))
        if not data:
            raise ValueError("the model gave no usable answer")
        return data

    async def plan_queries(self, description: str, keywords: str, platforms: list[str], per_platform: int) -> dict[str, list[str]]:
        names = {"tiktok": "TikTok", "instagram": "Instagram Reels"}
        prompt = (
            "You plan searches for a tool that finds short-form reference videos.\n"
            f"The user wants: {description or '(see keywords)'}\n"
            f"Keywords they gave: {keywords or 'none'}\n\n"
            f"Write {per_platform} different search queries for each of: "
            f"{', '.join(names[p] for p in platforms)}.\n"
            "Rules: each query is 1-3 words, like a person types into the app's search box. "
            "At least a third of them are single hashtags with no spaces (e.g. #cardrift). "
            "Every query must use different words — cover synonyms, related niches and the slang creators "
            "put in captions, instead of repeating the same words. "
            'Answer as JSON: {"tiktok": [...], "instagram": [...]}. '
            "Use an empty list for a platform that wasn't asked for."
        )
        data = await self._chat(prompt, PLAN_SCHEMA, max_tokens=500)
        return {p: _dedupe([q for q in data.get(p, []) if isinstance(q, str)], per_platform) for p in platforms}

    async def judge(self, description: str, keywords: str, c: Candidate, image: bytes | None) -> Verdict:
        prompt = (
            "You check whether a short-form video matches what a video editor is looking for.\n"
            f"They want: {description or keywords}\n"
            + (f"Must relate to: {keywords}\n" if keywords and description else "")
            + f"\nThe video:\n{_describe(c)}\n"
            + ("The image is the video's cover frame.\n" if image and self.can_see else "")
            + "\nScore 0-100 how well this video matches. Be strict: above 70 only when the caption "
            "or cover clearly shows the requested content, 40-70 if it's related but uncertain, below 40 if "
            "it's off-topic, a slideshow, a meme template, or an ad. Give a one-sentence reason "
            '(max 20 words). Answer as JSON: {"score": <int>, "reason": "<text>"}'
        )
        data = await self._chat(prompt, VERDICT_SCHEMA, [image] if image else None)
        return _verdict(data)

    async def verify_frames(self, description: str, frames: list[bytes]) -> Verdict:
        if not self.can_see or not frames:
            return Verdict(100, "Skipped (model can't see images)")
        prompt = (
            f"These are {len(frames)} frames from the start, middle and end of a downloaded short video.\n"
            f"The user wanted: {description}\n"
            "Score 0-100 how well the actual footage matches. Answer as JSON: "
            '{"score": <int>, "reason": "<one sentence>"}'
        )
        return _verdict(await self._chat(prompt, VERDICT_SCHEMA, frames))


def _verdict(data: dict) -> Verdict:
    try:
        score = int(float(data.get("score", 0)))
    except (TypeError, ValueError):
        score = 0
    return Verdict(max(0, min(100, score)), str(data.get("reason") or "").strip()[:200])


def parse_json_object(text: str) -> dict:
    """Parse a model's JSON answer, tolerating code fences or chatter around it."""
    text = re.sub(r"<think>.*?</think>", "", text or "", flags=re.S).strip()
    try:
        value = json.loads(text)
        return value if isinstance(value, dict) else {}
    except json.JSONDecodeError:
        pass
    match = re.search(r"\{.*\}", text, flags=re.S)
    if match:
        try:
            value = json.loads(match.group(0))
            return value if isinstance(value, dict) else {}
        except json.JSONDecodeError:
            return {}
    return {}


async def ollama_models(host: str = OLLAMA_HOST, transport: httpx.AsyncBaseTransport | None = None) -> list[str] | None:
    """Installed model names, or None if Ollama isn't running."""
    try:
        async with httpx.AsyncClient(timeout=3, transport=transport) as client:
            resp = await client.get(f"{host.rstrip('/')}/api/tags")
            resp.raise_for_status()
            return sorted(m["name"] for m in resp.json().get("models", []))
    except (httpx.HTTPError, ValueError, KeyError):
        return None


def model_installed(model: str, installed: list[str]) -> bool:
    names = set(installed)
    return model in names or f"{model}:latest" in names


async def pick_brain(
    model: str, host: str = OLLAMA_HOST, transport: httpx.AsyncBaseTransport | None = None
) -> tuple[OllamaBrain | KeywordBrain, str | None]:
    """The Ollama brain if the model is ready, else the keyword fallback plus a warning."""
    installed = await ollama_models(host, transport)
    if installed is None:
        return KeywordBrain(), "Ollama isn't running, so videos are matched by keywords only."
    if not model_installed(model, installed):
        return KeywordBrain(), (
            f"The AI model “{model}” isn't installed (run: ollama pull {model}). "
            "Using keyword matching for now."
        )
    return OllamaBrain(model, host, transport=transport), None


_VISION_FAMILIES = (
    "qwen3-vl", "qwen2.5vl", "qwen2.5-vl", "gemma3", "gemma4", "llama3.2-vision", "llama4", "llava",
    "minicpm-v", "moondream", "granite3.2-vision", "mistral-small3", "bakllava",
)


def sees_images(model: str) -> bool:
    """Best guess from the model name; the brain also detects text-only models at runtime."""
    name = model.lower()
    return any(name.startswith(f) for f in _VISION_FAMILIES) and not name.startswith("gemma3:1b")
