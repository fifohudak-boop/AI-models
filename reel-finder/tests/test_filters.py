import time

from reelfinder.config import HuntSettings
from reelfinder.filters import excluded_term, needs_probe, reject_reason
from reelfinder.models import Candidate


def cand(**kw):
    base = dict(platform="tiktok", id="1", url="u", caption="night drift #cardrift", thumbnail_url="t")
    base.update(kw)
    return Candidate(**base)


def test_duration_views_likes_age():
    s = HuntSettings(min_duration=5, max_duration=30, min_views=1000, min_likes=10, max_age_days=30)
    now = time.time()
    assert reject_reason(cand(duration=3), s) == "Too short (3s)"
    assert reject_reason(cand(duration=45), s) == "Too long (45s)"
    assert reject_reason(cand(duration=10, views=500), s) == "Only 500 views"
    assert reject_reason(cand(duration=10, views=5000, likes=2), s) == "Only 2 likes"
    assert "Too old" in reject_reason(cand(duration=10, views=5000, likes=20, timestamp=int(now - 40 * 86400)), s)
    assert reject_reason(cand(duration=10, views=5000, likes=20, timestamp=int(now - 86400)), s) is None
    # Unknown values pass (the probe may fill them in later).
    assert reject_reason(cand(), s) is None


def test_max_duration_zero_means_no_limit():
    assert reject_reason(cand(duration=500), HuntSettings(max_duration=0)) is None


def test_excluded_words():
    assert excluded_term("Giveaway time!", ["giveaway"]) == "giveaway"
    assert excluded_term("tutorials are great", ["tutorial"]) is None  # whole words only
    assert excluded_term("watch #ad now", ["#ad"]) == "#ad"
    s = HuntSettings(exclude="tutorial, #ad")
    assert reject_reason(cand(caption="drift tutorial"), s) == "Contains excluded word “tutorial”"


def test_needs_probe():
    s = HuntSettings(min_duration=0, max_duration=0)
    assert not needs_probe(cand(), s)
    assert needs_probe(cand(caption=""), s)
    assert needs_probe(cand(thumbnail_url=None), s)
    assert needs_probe(cand(maybe_not_video=True), s)
    assert needs_probe(cand(), HuntSettings(max_duration=60))  # duration unknown
    assert not needs_probe(cand(duration=12), HuntSettings(max_duration=60))
    assert needs_probe(cand(duration=12), HuntSettings(max_duration=60, min_views=5))
