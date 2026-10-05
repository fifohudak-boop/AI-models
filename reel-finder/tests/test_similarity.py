import io

import numpy as np
import pytest

from reelfinder.similarity import (
    ReferenceSet, Vision, closeness_label, look_score, look_weight, min_look, text_score, vision,
)


def unit(*xs):
    v = np.array(xs, dtype=np.float32)
    return v / np.linalg.norm(v)


def test_scores_are_calibrated():
    assert look_score(0.50) == 0  # unrelated videos
    assert 55 <= look_score(0.76) <= 65  # the same kind of video
    assert look_score(0.93) == 100  # a video's own frames vs its cover
    assert text_score(0.13) == 0 and text_score(0.30) >= 80


def test_closeness_settings():
    assert min_look(0) == min_look(45) == 0  # "Same kind of video": always save the number asked for
    assert 0 < min_look(60) < min_look(80) < min_look(100) <= 70
    assert look_weight(0) == pytest.approx(0.4) and look_weight(100) == pytest.approx(0.9)
    assert [closeness_label(v) for v in (10, 60, 80, 95)] == [
        "Same kind of video", "Same look", "Very close", "Nearly identical"]


def test_reference_set_picks_the_best_matching_reference():
    refs = ReferenceSet([np.stack([unit(1, 0, 0), unit(1, 0.1, 0)]), np.stack([unit(0, 0, 1)])])
    assert refs.look(unit(1, 0, 0)) >= 95
    assert refs.look(unit(0, 0, 1)) == 100  # matches the second reference exactly
    assert refs.look(unit(0, 1, 0)) == 0
    mostly = np.stack([unit(1, 0, 0)] * 3 + [unit(0, 1, 0)])  # one frame in four looks different
    assert 0 < refs.frames_look(mostly) < refs.frames_look(np.stack([unit(1, 0, 0)])) == 100
    assert refs.frames_look(np.stack([unit(1, 0, 0), unit(0, 1, 0)])) == 0  # half of it: not alike
    assert not ReferenceSet() and refs


def word_card(word: str, color: str, shift: int = 0) -> bytes:
    from PIL import Image, ImageDraw, ImageFont

    im = Image.new("RGB", (270, 480), color)
    ImageDraw.Draw(im).text((20 + shift, 180 + shift), word, fill="white", font=ImageFont.load_default(size=64))
    buf = io.BytesIO()
    im.save(buf, "JPEG")
    return buf.getvalue()


needs_model = pytest.mark.skipif(not Vision.installed(), reason="fastembed not installed")


@needs_model
def test_real_model_tells_videos_apart():
    if not vision.load():
        pytest.skip(f"similarity model unavailable: {vision.error}")
    cards = {w: word_card(w, c) for w, c in [("DRIFT", "#e8335f"), ("PASTA", "#2563eb"), ("KITTEN", "#f59e0b")]}
    ref = ReferenceSet([vision.embed_images([word_card("KITTEN", "#f59e0b", 12)])])
    looks = {w: ref.look(v) for w, v in zip(cards, vision.embed_images(list(cards.values())), strict=True)}
    assert looks["KITTEN"] >= 90 and max(looks["DRIFT"], looks["PASTA"]) < 60, looks
    assert vision.tags(vision.embed_images([cards["KITTEN"]]))  # always at least one theme
    with pytest.raises(ValueError):
        vision.embed_images([b"not a picture"])
