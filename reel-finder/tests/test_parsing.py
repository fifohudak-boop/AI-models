from conftest import load_fixture
from reelfinder.parsing import (
    parse_instagram_json,
    parse_instagram_links,
    parse_tiktok_json,
    parse_tiktok_links,
    split_terms,
)


def test_tiktok_web_search_items():
    cands = parse_tiktok_json(load_fixture("tiktok_search.json"))
    assert [c.id for c in cands] == ["7412345678901234567", "7412345678901234569"]  # photo post skipped
    first = cands[0]
    assert first.url == "https://www.tiktok.com/@driftking/video/7412345678901234567"
    assert first.author == "driftking"
    assert first.views == 154000 and first.likes == 12000
    assert first.duration == 14
    assert first.timestamp == 1725000000
    assert first.thumbnail_url == "https://p16.example/origin1.jpeg"
    assert "#cardrift" in first.caption
    # statsV2 strings are used when stats is missing
    assert cands[1].views == 2500 and cands[1].likes == 90


def test_tiktok_general_search_and_app_shapes():
    general = parse_tiktok_json(load_fixture("tiktok_general.json"))
    assert [c.id for c in general] == ["7412345678901234571"]
    app = parse_tiktok_json(load_fixture("tiktok_app.json"))
    assert app[0].id == "7412345678901234570"
    assert app[0].duration == 15.2  # milliseconds → seconds
    assert app[0].thumbnail_url == "https://p16.example/app.jpeg"
    assert app[0].views == 999


def test_tiktok_links():
    links = [
        {"href": "/@some.user/video/7412345678901234567", "alt": "caption from alt"},
        {"href": "https://www.tiktok.com/@x_y/video/7412345678901234599?is_from_webapp=1", "text": "text"},
        {"href": "/@pics/photo/7412345678901234568"},
        {"href": "/tag/cardrift"},
    ]
    cands = parse_tiktok_links(links)
    assert [(c.author, c.id) for c in cands] == [("some.user", "7412345678901234567"), ("x_y", "7412345678901234599")]
    assert cands[0].caption == "caption from alt"


def test_instagram_v1_media():
    cands = parse_instagram_json(load_fixture("instagram_search.json"))
    assert [c.id for c in cands] == ["C1aBcDeFgH", "C6NoCaption"]  # photo + carousel skipped
    reel = cands[0]
    assert reel.url == "https://www.instagram.com/reel/C1aBcDeFgH/"
    assert reel.views == 52000  # ig_play_count preferred
    assert reel.likes == 4100
    assert reel.duration == 12.4
    assert reel.author == "nightdrifter"
    assert reel.thumbnail_url == "https://ig.example/640.jpg"  # closest to 640px
    assert cands[1].caption == "" and cands[1].views is None


def test_instagram_graph_media():
    cands = parse_instagram_json(load_fixture("instagram_graph.json"))
    assert len(cands) == 1
    c = cands[0]
    assert (c.id, c.caption, c.views, c.likes, c.author) == ("C4Graph123", "graph caption", 777, 55, "graphuser")


def test_instagram_links():
    links = [
        {"href": "/reel/Cabc12345/"},
        {"href": "/someuser/reel/Cdef67890/"},
        {"href": "https://www.instagram.com/p/Cghi_-1234/", "alt": "Photo by someone"},
        {"href": "/explore/tags/cars/"},
    ]
    cands = parse_instagram_links(links)
    assert [c.id for c in cands] == ["Cabc12345", "Cdef67890", "Cghi_-1234"]
    assert [c.maybe_not_video for c in cands] == [False, False, True]


def test_split_terms():
    assert split_terms(" a, b\n#c ;A,, ") == ["a", "b", "#c"]
    assert split_terms("") == []


def test_parsers_ignore_garbage():
    assert parse_tiktok_json({"weird": [1, "x", None, {"id": "123"}]}) == []
    assert parse_instagram_json(["nope", 3, {"code": 5}]) == []


def test_pinterest_real_search_results():
    from reelfinder.parsing import parse_pinterest_json

    cands = parse_pinterest_json(load_fixture("pinterest_search.json"))
    by_id = {c.id: c for c in cands}
    assert "1111111111111111" not in by_id  # promoted pins (ads) are dropped
    assert "6977350996506936" not in by_id  # the "story" carousel isn't a pin
    video = by_id["1052716481630882749"]
    assert video.kind == "video" and video.rich and video.duration == 7.1
    assert video.url == "https://www.pinterest.com/pin/1052716481630882749/"
    assert video.caption.startswith("Mercedes Drift") and video.author == "kd6459142"
    assert video.likes and video.timestamp and video.thumbnail_url.startswith("https://i.pinimg.com/474x/")
    assert by_id["9148005522406293"].kind == "video"  # an Idea pin with a clip inside
    images = [c for c in cands if c.kind == "image"]
    assert len(images) == 2 and all(c.image_url and "/originals/" in c.image_url for c in images)


def test_pinterest_caption_has_no_repeats():
    from reelfinder.parsing import parse_pinterest_json

    pin = {"type": "pin", "id": "1", "grid_title": "Night drift", "title": "Night drift",
           "description": "Night drift with smoke #cardrift", "auto_alt_text": "a car drifting at night",
           "images": {"474x": {"url": "https://i.pinimg.com/474x/a.jpg"}},
           "videos": {"video_list": {"V_720P": {"url": "u", "duration": 5000}}}}
    [c] = parse_pinterest_json({"resource_response": {"data": {"results": [pin]}}})
    assert c.caption == "Night drift with smoke #cardrift · a car drifting at night"


def test_pinterest_links():
    from reelfinder.parsing import parse_pinterest_links

    cands = parse_pinterest_links([
        {"href": "/pin/1052716481630882749/", "alt": "Mercedes drift at night",
         "src": "https://i.pinimg.com/236x/26/5d/ed/265ded.jpg"},
        {"href": "https://www.pinterest.co.uk/pin/some-title--27514247718193220/", "alt": ""},
        {"href": "/ideas/cars/123/"},
    ])
    assert [c.id for c in cands] == ["1052716481630882749", "27514247718193220"]
    first = cands[0]
    assert first.maybe_not_video and first.caption == "Mercedes drift at night"
    assert first.thumbnail_url == "https://i.pinimg.com/474x/26/5d/ed/265ded.jpg"
    assert first.image_url == "https://i.pinimg.com/736x/26/5d/ed/265ded.jpg"


def test_page_links_carry_their_cover_image():
    links = [{"href": "/@a/video/7412345678901234567", "alt": "x", "src": "https://p16.example/c.jpeg"},
             {"href": "/p/Cabc12345/", "src": "data:image/gif;base64,R0lGOD"}]
    assert parse_tiktok_links(links[:1])[0].thumbnail_url == "https://p16.example/c.jpeg"
    assert parse_instagram_links(links[1:])[0].thumbnail_url is None  # placeholders ignored


def test_site_data_beats_a_bare_link():
    from reelfinder.models import Candidate

    link = Candidate(platform="instagram", id="C1", url="u", caption="Photo by someone", maybe_not_video=True)
    rich = Candidate(platform="instagram", id="C1", url="u", caption="Night drift with smoke", views=5, rich=True)
    link.merge(rich)
    assert (link.caption, link.views, link.rich, link.maybe_not_video) == ("Night drift with smoke", 5, True, False)
