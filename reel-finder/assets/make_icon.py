"""Builds the Mac app icon (assets/AppIcon.icns) from web/logo.svg.

Run from the reel-finder folder:  .venv/bin/python assets/make_icon.py
It draws the logo the way macOS app icons are laid out (an 824 px tile with a soft shadow on a
1024 px canvas) using the agents' browser, then packs every size macOS needs into one .icns.
"""

import asyncio
import io
import os
import sys
from pathlib import Path

from PIL import Image
from playwright.async_api import async_playwright

HERE = Path(__file__).resolve().parent
SVG = HERE.parent / "web" / "logo.svg"
PAGE = """<!doctype html><html><body style="margin:0;background:transparent">
<div style="width:1024px;height:1024px;display:grid;place-items:center">
<img src="data:image/svg+xml;base64,{b64}" style="width:824px;height:824px;
 filter:drop-shadow(0 10px 14px rgb(0 0 0 / .28))"></div></body></html>"""


async def render() -> bytes:
    import base64

    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get("REELFINDER_BROWSER_PATH") or None)
        page = await browser.new_page(viewport={"width": 1024, "height": 1024})
        await page.set_content(PAGE.format(b64=base64.b64encode(SVG.read_bytes()).decode()))
        await page.wait_for_timeout(300)
        png = await page.screenshot(omit_background=True)
        await browser.close()
        return png


def main() -> None:
    master = Image.open(io.BytesIO(asyncio.run(render()))).convert("RGBA")
    master.save(HERE / "AppIcon.icns")  # Pillow writes every size macOS needs (16 … 1024 px)
    print("wrote", HERE / "AppIcon.icns", file=sys.stderr)


if __name__ == "__main__":
    main()
