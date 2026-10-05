"""A tiny stand-in for TikTok, Instagram and Pinterest, used to test the agents end to end.

It behaves like the real sites in the ways that matter: search pages load more videos
via JSON API calls as you scroll, tiles link to /@user/video/<id> (TikTok) or /p/<code>/
(Instagram), video pages embed a playable <video>, and there are captcha and login walls.

Run it on its own with:  python tests/fakesite.py  (prints its URL)
"""

from __future__ import annotations

import html
import http.server
import json
import re
import subprocess
import sys
import tempfile
import threading
import time
import zlib
from pathlib import Path
from urllib.parse import parse_qs, quote, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from reelfinder.downloader import find_ffmpeg  # noqa: E402

PAGES = 4
PER_PAGE = 6
COLORS = ["0xe8335f", "0x2563eb", "0x16a34a", "0xf59e0b", "0x7c3aed", "0x0891b2"]

GRID_PAGE = """<!doctype html><html><head><meta charset="utf-8"><title>{title}</title>
<style>body{{margin:0;font-family:sans-serif;background:{bg}}}#grid{{display:grid;grid-template-columns:repeat(4,1fr);
gap:8px;padding:8px}}.tile{{display:block;height:520px;background:#ccc;overflow:hidden}}.tile img{{width:100%;height:100%;
object-fit:cover}}h1{{margin:8px;font-size:16px}}</style></head><body><h1>{title}</h1>{captcha}<div id="grid"></div>
<script>
const q = new URLSearchParams(location.search).get('q') || '';
let page = 0, loading = false, more = true;
async function load() {{
  if (loading || !more) return; loading = true;
  const r = await fetch('{api}' + encodeURIComponent(q) + '&page=' + page);
  const d = await r.json(); page += 1; more = !!d.has_more;
  for (const it of d.tiles) {{
    const a = document.createElement('a'); a.className = 'tile'; a.href = it.href;
    const img = document.createElement('img'); img.alt = it.alt; img.src = it.cover; a.append(img);
    document.getElementById('grid').append(a);
  }}
  loading = false;
  // Like an IntersectionObserver: keep loading until the page can scroll.
  if (more && document.body.scrollHeight <= window.innerHeight + 50) load();
}}
load();
window.addEventListener('scroll', () => {{
  if (window.innerHeight + window.scrollY > document.body.scrollHeight - 700) load();
}});
</script></body></html>"""

CAPTCHA = """<div id="captcha-verify-container-main-page" style="padding:20px;background:#fee">Verify you are human</div>
<script>setTimeout(() => document.getElementById('captcha-verify-container-main-page').remove(), 6000)</script>"""


# What Pinterest shows when you're not logged in: a sign-up pop-up over the first results, with an
# invisible reCAPTCHA inside (which must not be mistaken for a captcha you have to solve).
PINTEREST_WALL = """<div data-test-id="fullPageSignupModal" style="position:fixed;top:80px;left:80px;width:400px;
height:420px;background:#fff;border-radius:16px;z-index:9">Welcome to Pinterest<form><input id="email" type="email">
<iframe src="/recaptcha/enterprise/anchor" style="visibility:hidden;width:256px;height:60px"></iframe></form></div>"""


def _n(q: str, page: int, i: int) -> int:
    return page * PER_PAGE + i


def _caption(q: str, n: int) -> str:
    if n % 2 == 0:
        return f"Night drift run {n} with smoke #cardrift #{q.replace(' ', '').lstrip('#')}"
    return f"Cooking pasta tutorial {n} #food"


def tiktok_item(base: str, q: str, page: int, i: int) -> dict:
    n = _n(q, page, i)
    vid = str(7400000000000000000 + (zlib.crc32(q.encode()) % 100000) * 1000 + n)
    return {
        "id": vid, "desc": _caption(q, n), "createTime": int(time.time()) - 86400 * n,
        "author": {"uniqueId": f"driver{n % 5}"},
        "stats": {"playCount": 1500 * (n + 1), "diggCount": 90 * (n + 1)},
        "video": {"duration": 8 + n % 20, "cover": f"{base}/cover/{n % len(COLORS)}.jpg"},
    }


WORDS = ["DRIFT", "PASTA", "BEACH", "KITTEN", "GYM", "GUITAR"]


def make_cover(k: int, path: Path) -> bool:
    """Cover k: a coloured card with a big word. The similarity model reads the word, so the six
    covers look clearly different to it, while a video of the same card looks identical."""
    try:
        from PIL import Image, ImageDraw, ImageFont
    except ImportError:
        return False
    im = Image.new("RGB", (270, 480), "#" + COLORS[k][2:])
    ImageDraw.Draw(im).text((20, 180), WORDS[k], fill="white", font=ImageFont.load_default(size=64))
    im.save(path, "JPEG")
    return True


def media_for(n: int) -> str:
    """Like the real sites, some posts don't give you a normal video:
    n % 6 == 4 → a "video" that's only music (TikTok photo slideshows do this),
    n % 6 == 2 → HEVC/H.265 video (TikTok's 1080p), which QuickTime often can't show.
    The rest look exactly like their cover."""
    return {4: "audio_only.mp4", 2: "clip_hevc.mp4"}.get(n % 6, f"look_{n % len(COLORS)}.mp4")


def pinterest_pin(base: str, q: str, page: int, i: int, scope: str) -> dict:
    n = _n(q, page, i)
    is_image = scope == "pins" and n % 3 == 1
    pid = str((800 if is_image else 900) * 10**12 + (zlib.crc32(q.encode()) % 100000) * 1000 + n)
    cover = f"{base}/cover/{n % len(COLORS)}.jpg"
    pin = {
        "type": "pin", "id": pid, "grid_title": _caption(q, n).split(" #")[0], "description": _caption(q, n),
        "created_at": "Tue, 12 Mar 2024 10:00:00 +0000", "is_promoted": n == 11,
        "pinner": {"username": f"pinner{n % 3}"}, "reaction_counts": {"1": 40 * (n + 1)},
        "images": {"236x": {"url": cover}, "474x": {"url": cover}, "orig": {"url": cover, "width": 270, "height": 480}},
        "videos": None if is_image else {"video_list": {"V_720P": {"url": f"{base}/media/clip.mp4",
                                                                    "duration": (6 + n % 9) * 1000}}},
    }
    return pin


def instagram_media(base: str, q: str, page: int, i: int) -> dict:
    n = _n(q, page, i)
    code = f"C{zlib.crc32(q.encode()) % 100000:05d}x{n:03d}"
    return {
        "code": code, "media_type": 1 if n % 6 == 5 else 2, "product_type": "clips",
        "taken_at": int(time.time()) - 86400 * n, "caption": {"text": _caption(q, n)},
        "user": {"username": f"reels{n % 4}"}, "play_count": 2000 * (n + 1), "like_count": 70 * (n + 1),
        "video_duration": 6.0 + n % 15,
        "image_versions2": {"candidates": [{"width": 640, "height": 1137, "url": f"{base}/cover/{n % len(COLORS)}.jpg"}]},
    }


class FakeSite:
    def __init__(self) -> None:
        self.dir = Path(tempfile.mkdtemp(prefix="fakesite-"))
        self.requests: list[str] = []
        self._make_media()
        handler = self._handler()
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"

    def _make_media(self) -> None:
        ffmpeg = find_ffmpeg()
        if not ffmpeg:
            return
        for k, color in enumerate(COLORS):
            if not make_cover(k, self.dir / f"{k}.jpg"):
                subprocess.run([ffmpeg, "-v", "error", "-y", "-f", "lavfi", "-i", f"color=c={color}:size=270x480",
                                "-frames:v", "1", str(self.dir / f"{k}.jpg")], check=True)
            # A video that looks like its cover, so "does it look like the reference" can be tested.
            subprocess.run([ffmpeg, "-v", "error", "-y", "-loop", "1", "-i", str(self.dir / f"{k}.jpg"), "-f", "lavfi",
                            "-i", "sine=frequency=440:duration=3", "-t", "3", "-r", "25", "-c:v", "libx264",
                            "-pix_fmt", "yuv420p", "-vf", "scale=270:480", "-c:a", "aac", "-shortest",
                            str(self.dir / f"look_{k}.mp4")], check=True)
        subprocess.run([ffmpeg, "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=360x640:rate=25:duration=3",
                        "-f", "lavfi", "-i", "sine=frequency=330:duration=3", "-shortest", "-c:v", "libx264",
                        "-pix_fmt", "yuv420p", "-c:a", "aac", str(self.dir / "clip.mp4")], check=True)
        subprocess.run([ffmpeg, "-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=500:duration=3",
                        "-c:a", "aac", str(self.dir / "audio_only.mp4")], check=True)
        hevc = subprocess.run([ffmpeg, "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=360x640:rate=25:duration=3",
                               "-f", "lavfi", "-i", "sine=frequency=700:duration=3", "-shortest", "-c:v", "libx265",
                               "-tag:v", "hev1", "-pix_fmt", "yuv420p", "-c:a", "aac", str(self.dir / "clip_hevc.mp4")])
        if hevc.returncode != 0:  # no HEVC encoder here: fall back to a normal clip
            (self.dir / "clip_hevc.mp4").write_bytes((self.dir / "clip.mp4").read_bytes())

    def start(self) -> FakeSite:
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        return self

    def stop(self) -> None:
        self.server.shutdown()

    def _handler(self):
        site = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def _send(self, body: bytes, ctype: str, status: int = 200, headers: dict | None = None):
                self.send_response(status)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(body)))
                for k, v in (headers or {}).items():
                    self.send_header(k, v)
                self.end_headers()
                self.wfile.write(body)

            def _json(self, data):
                self._send(json.dumps(data).encode(), "application/json; charset=utf-8")

            def _html(self, text: str):
                self._send(text.encode(), "text/html; charset=utf-8")

            def do_GET(self):  # noqa: N802 - http.server API
                url = urlparse(self.path)
                qs = {k: v[0] for k, v in parse_qs(url.query).items()}
                path = url.path
                site.requests.append(self.path)
                base = site.url

                if path in ("/search/videos/", "/search/pins/"):
                    q, scope = qs.get("q", ""), path.split("/")[2]
                    if q == "needlogin":
                        return self._send(b"", "text/html", 302, {"Location": "/login/"})
                    return self._html(GRID_PAGE.format(
                        title=f"Pinterest {scope} search: {html.escape(q)}", bg="#fff",
                        captcha=PINTEREST_WALL if q == "loginwall" else "",
                        api=f"/resource/BaseSearchResource/get/?scope={scope}&q=",
                    ))

                if path == "/resource/BaseSearchResource/get/":
                    q, page, scope = qs.get("q", ""), int(qs.get("page", 0)), qs.get("scope", "videos")
                    pins = [pinterest_pin(base, q, page, i, scope) for i in range(PER_PAGE)]
                    tiles = [{"href": f"/pin/{p['id']}/", "alt": p["description"], "cover": p["images"]["236x"]["url"]}
                             for p in pins]
                    return self._json({"resource_response": {"data": {"results": pins}},
                                       "has_more": int(page + 1 < PAGES), "tiles": tiles})

                if path.startswith("/pin/"):
                    pid = path.strip("/").split("/")[-1]
                    # Image pins (ids starting with 8) have no <video>, so yt-dlp finds nothing there.
                    look = f"look_{int(pid) % 1000 % len(COLORS)}.mp4" if pid.isdigit() else "clip.mp4"
                    body = '<img src="/cover/0.jpg">' if pid.startswith("8") else f'<video src="/media/{look}"></video>'
                    return self._html(f"<!doctype html><html><head><title>pin {pid}</title></head><body>{body}</body></html>")

                if path in ("/search/video", "/explore/search/keyword/") or path.startswith("/tag/"):
                    is_ig = path.startswith("/explore")
                    q = qs.get("q", "") if not path.startswith("/tag/") else "#" + path.split("/")[2]
                    if is_ig and q == "needlogin":
                        return self._send(b"", "text/html", 302, {"Location": "/accounts/login/"})
                    page = GRID_PAGE.format(
                        title=("Instagram" if is_ig else "TikTok") + f" search: {html.escape(q)}",
                        bg="#fafafa" if is_ig else "#fff",
                        captcha=CAPTCHA if q == "captcha" else "",
                        api="/api/v1/fbsearch/web/top_serp/?query=" if is_ig else "/api/search/item/full/?keyword=",
                    )
                    if path.startswith("/tag/"):
                        page = page.replace("new URLSearchParams(location.search).get('q') || ''", json.dumps(q))
                    return self._html(page)

                if path == "/api/search/item/full/":
                    q, page = qs.get("keyword", ""), int(qs.get("page", 0))
                    items = [tiktok_item(base, q, page, i) for i in range(PER_PAGE)]
                    tiles = [{"href": f"/@{it['author']['uniqueId']}/video/{it['id']}", "alt": it["desc"],
                              "cover": it["video"]["cover"]} for it in items]
                    return self._json({"item_list": items, "has_more": int(page + 1 < PAGES), "tiles": tiles})

                if path == "/api/v1/fbsearch/web/top_serp/":
                    q, page = qs.get("query", ""), int(qs.get("page", 0))
                    medias = [instagram_media(base, q, page, i) for i in range(PER_PAGE)]
                    tiles = [{"href": f"/p/{m['code']}/", "alt": "", "cover": m["image_versions2"]["candidates"][0]["url"]}
                             for m in medias]
                    return self._json({"media_grid": {"sections": [{"layout_content": {"medias": [{"media": m} for m in medias]}}]},
                                       "has_more": int(page + 1 < PAGES), "tiles": tiles})

                if "/video/" in path or path.startswith(("/reel/", "/p/")):
                    title = html.escape(path.strip("/").replace("/", " "))
                    n = int(re.sub(r"\D", "", path.strip("/").split("/")[-1][-3:]) or 0)
                    return self._html(f'<!doctype html><html><head><title>{title}</title></head><body>'
                                      f'<video src="/media/{media_for(n)}" controls></video></body></html>')

                if path.startswith(("/cover/", "/media/")):
                    f = site.dir / path.rsplit("/", 1)[-1]
                    if f.exists():
                        ctype = "image/jpeg" if f.suffix == ".jpg" else "video/mp4"
                        return self._send(f.read_bytes(), ctype)
                    return self._send(b"not found", "text/plain", 404)

                if path.startswith("/accounts/login"):
                    return self._html("<h1>Log in to Instagram</h1>")
                if path == "/login":
                    return self._html("<h1>Log in to TikTok</h1>")
                if path == "/login/":
                    return self._html("<h1>Log in to Pinterest</h1>")
                return self._send(b"not found", "text/plain", 404)

        return Handler


if __name__ == "__main__":
    fake = FakeSite().start()
    print(fake.url, flush=True)
    print(f"Try: {fake.url}/search/video?q={quote('night drift')}", flush=True)
    threading.Event().wait()
