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
need looking find some any like just only more most also really pinterest pin pins reference
references please get give show
""".split())

PLATFORM_NAMES = {"tiktok": "TikTok", "instagram": "Instagram Reels", "pinterest": "Pinterest"}

PLAN_SCHEMA = {
    "type": "object",
    "properties": {p: {"type": "array", "items": {"type": "string"}} for p in PLATFORM_NAMES},
    "required": list(PLATFORM_NAMES),
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


def _dedupe(queries: list[str], limit: int, avoid: set[str] | None = None) -> list[str]:
    out: dict[str, str] = {}
    for q in queries:
        q = re.sub(r"\s+", " ", str(q)).strip().strip('"')
        if q and q.lower() not in out and q.lower() not in (avoid or set()):
            out[q.lower()] = q
    return list(out.values())[:limit]


def core_query(description: str, words: int = 5) -> str:
    """Your own description, boiled down to the words a search box needs ("night car drift smoke")."""
    return " ".join(_words(description)[:words])


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

    async def plan_queries(self, description: str, keywords: str, platforms: list[str], per_platform: int,
                           avoid: list[str] | tuple = ()) -> dict[str, list[str]]:
        terms = split_terms(keywords)
        words = _words(description)
        base = terms + ([" ".join(words[:4])] if words else [])
        base += [" ".join(words[i:i + 2]) for i in range(0, max(len(words) - 1, 0), 2)]
        base += [" ".join(words[i:i + 3]) for i in range(1, max(len(words) - 2, 0))]
        base += [f"{a} {b}" for i, a in enumerate(words[:5]) for b in words[i + 2:6]]
        hashtags = ["#" + w for w in words[:6]] + ["#" + "".join(words[i:i + 2]) for i in range(0, max(len(words) - 1, 0))]
        queries = _dedupe(base + hashtags, per_platform, {a.lower() for a in avoid})
        return {p: [q.lstrip("#") if p == "pinterest" else q for q in queries] for p in platforms}

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
                    return await self._chat(prompt, schema, images, max_tokens)
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

    async def plan_queries(self, description: str, keywords: str, platforms: list[str], per_platform: int,
                           avoid: list[str] | tuple = ()) -> dict[str, list[str]]:
        styles = {
            "tiktok": "1-3 words or a single #hashtag (no spaces), the way TikTok creators caption such videos",
            "instagram": "1-3 words or a single #hashtag (no spaces), the way Instagram Reels are captioned",
            "pinterest": "2-5 descriptive words, no hashtags, the way people search Pinterest for "
                         "aesthetic references (e.g. 'cinematic night drift', 'moody car photography')",
        }
        prompt = (
            "You plan searches for a tool that finds short-form reference videos for a video editor.\n"
            f"They want: {description or '(see keywords)'}\n"
            f"Keywords they gave: {keywords or 'none'}\n\n"
            f"Write {per_platform} search queries for each of these platforms:\n"
            + "".join(f"- {p}: {styles[p]}\n" for p in platforms)
            + "Each query must find exactly this kind of video: keep the main subject in every query, and "
            "vary the angle (style, mood, setting, technique, the slang and niche words creators use). "
            "Start with the most direct, literal searches; put wider ones at the end. "
            + (f"Don't repeat any of these, they were already searched: {', '.join(avoid)}. " if avoid else "")
            + 'Answer as JSON: {"tiktok": [...], "instagram": [...], "pinterest": [...]} '
            "with an empty list for any platform not listed above."
        )
        data = await self._chat(prompt, PLAN_SCHEMA, max_tokens=700)
        avoid_set = {a.lower() for a in avoid}
        return {p: _dedupe([q for q in data.get(p, []) if isinstance(q, str)], per_platform, avoid_set)
                for p in platforms}

    async def judge(self, description: str, keywords: str, c: Candidate, image: bytes | None) -> Verdict:
        if c.kind == "image":
            what, seen = "picture", "The image is the picture itself.\n"
        else:
            what, seen = "video", "The image is the video's cover frame.\n"
        prompt = (
            f"You rate {what}s for a video editor who is collecting reference material.\n"
            f"What they want: {description or keywords}\n"
            + (f"It should involve: {keywords}\n" if keywords and description else "")
            + f"\nThe {what}:\n{_describe(c)}\n"
            + (seen if image and self.can_see else "")
            + "\nHow well does it match what they want? Score 0-100:\n"
            "90-100 exactly it: right subject AND the style/details they asked for\n"
            "70-89 right subject, most details match\n"
            "45-69 the subject is there but the style or details differ\n"
            "20-44 only loosely related\n"
            "0-19 unrelated, an ad, or a text/meme slideshow\n"
            "Judge mostly by what the image shows; use the caption to confirm (hashtag spam proves nothing).\n"
            'Answer as JSON: {"score": <int>, "reason": "<max 15 words>"}'
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
