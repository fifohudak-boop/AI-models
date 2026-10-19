"""AI Studio providers and automatic pricing.

Pure data + maths, no network — so it's easy to test and the UI can read it. Each model in AI Studio
belongs to a provider (the account + service the key is for). A persona's key config picks the
provider (and region, and for Wan the workspace); the model, resolution and length are chosen per
video on the Studio page.

Prices are worked out automatically from each provider's published rates — the user never types a
price. Sources (checked Oct 2026):
  - Alibaba Wan: per second, by region and resolution — alibabacloud.com/help/en/model-studio/wan3-0-video
  - ByteDance Seedance (video): $ / 1M tokens, tokens = W·H·24·seconds / 1024 — BytePlus ModelArk
  - ByteDance Seedream (image): flat per generated image — BytePlus ModelArk
"""

from __future__ import annotations

# ---------------------------------------------------------------- Alibaba Wan (video)

# Per-second USD. Singapore (international) is its own rail; the other regions share one.
WAN_PER_SECOND = {
    "sg": {"480P": 0.05, "720P": 0.10, "1080P": 0.20},
    "std": {"480P": 0.041256, "720P": 0.082513, "1080P": 0.165025},
}
WAN_PRIME_MULTIPLIER = 2.0  # Prime is the higher tier ("two price rails"); official per-second not published.
WAN_REGIONS = {
    "intl": ("Singapore (international)", "ap-southeast-1"),
    "cn": ("China (Beijing)", "cn-beijing"),
    "us": ("US (Virginia)", "us-east-1"),
    "eu": ("Germany (Frankfurt)", "eu-central-1"),
    "jp": ("Japan (Tokyo)", "ap-northeast-1"),
    "hk": ("China (Hong Kong)", "cn-hongkong"),
}


def _wan_tier(region: str) -> str:
    return "sg" if region == "intl" else "std"


def wan_price(model: str, region: str, resolution: str, seconds: float) -> float | None:
    rail = WAN_PER_SECOND.get(_wan_tier(region))
    if not rail or resolution not in rail or not seconds or seconds <= 0:
        return None
    per_s = rail[resolution] * (WAN_PRIME_MULTIPLIER if model.endswith("prime") else 1.0)
    return round(per_s * seconds, 4)


# ---------------------------------------------------------------- ByteDance Seedance (video)

# Tokens per second of finished video, by resolution (from BytePlus's own per-clip examples:
# 480p 5s = 48,600 tokens, 720p 5s = 108,000, 1080p 5s = 244,800 → divide by 5).
SEEDANCE_TOKENS_PER_SECOND = {"480p": 9720, "720p": 21600, "1080p": 48960}
SEEDANCE_USD_PER_MTOKEN = {  # list price, USD per 1,000,000 tokens
    "seedance-1.0-pro": 2.50,
    "seedance-1.0-lite": 1.00,
}


def seedance_price(model: str, resolution: str, seconds: float) -> float | None:
    tps = SEEDANCE_TOKENS_PER_SECOND.get(resolution)
    rate = SEEDANCE_USD_PER_MTOKEN.get(model)
    if not tps or rate is None or not seconds or seconds <= 0:
        return None
    return round(tps * seconds / 1_000_000 * rate, 4)


# ---------------------------------------------------------------- ByteDance Seedream (image)

SEEDREAM_USD_PER_IMAGE = {"seedream-4.0": 0.03, "seedream-3.0": 0.03}


def seedream_price(model: str, images: int = 1) -> float | None:
    per = SEEDREAM_USD_PER_IMAGE.get(model)
    if per is None:
        return None
    return round(per * max(1, images), 4)


# ---------------------------------------------------------------- WaveSpeed (aggregator)

# WaveSpeed is one key for many models; we wire its Seedance 2.5 video models.
WAVESPEED_HOST = "https://api.wavespeed.ai/api/v3"
WAVESPEED_MIN_S, WAVESPEED_MAX_S = 4, 30
# Per-second USD for Seedance 2.5 on WaveSpeed (their FAQ: $0.90/5s@480p, $1.80/5s@720p). 1080p is
# an estimate — WaveSpeed shows the exact price before you submit.
WAVESPEED_SEEDANCE_PER_S = {
    "std": {"480p": 0.18, "720p": 0.36, "1080p": 0.72},
    "turbo": {"480p": 0.20, "720p": 0.40, "1080p": 0.80},
}


def wavespeed_price(model: str, resolution: str, seconds: float) -> float | None:
    rail = "turbo" if model.endswith("turbo") else "std"
    rate = WAVESPEED_SEEDANCE_PER_S.get(rail, {}).get(resolution)
    if rate is None or not seconds or seconds <= 0:
        return None
    return round(rate * seconds, 4)


def wavespeed_path(model: str, mode: str) -> str:
    """The real WaveSpeed model path for our (model, mode) pair."""
    kind = "image-to-video" if mode == "image" else "text-to-video"
    suffix = "-turbo" if model.endswith("turbo") else ""
    return f"bytedance/seedance-2.5/{kind}{suffix}"


# ---------------------------------------------------------------- ArgoLink (images)

# OpenAI-style image API (argolink.io/v1/images/generations · /images/edits), synchronous.
ARGOLINK_HOST = "https://argolink.io/v1"
ARGOLINK_USD_PER_IMAGE = {"seedream-5.0-pro": 0.03}  # 1K and 2K both $0.03


def argolink_price(model: str, images: int = 1) -> float | None:
    per = ARGOLINK_USD_PER_IMAGE.get(model)
    if per is None:
        return None
    return round(per * max(1, images), 4)


# ---------------------------------------------------------------- VideoRouter (aggregator, video)

# VideoRouter (videorouter.sh) is an OpenAI-style router with an async video API: POST /api/v1/videos,
# then poll GET /api/v1/videos/{id}. One key (llmr_sk_live_…) covers its video models; we wire its
# Seedance 2.5 (and the cheaper 2.0). The model string is "<creator>/<model>/<host>". VideoRouter
# bills per requested second at creation time and shows the exact price before you submit, so these
# per-second rates (its published catalogue floors) are a close estimate.
VIDEOROUTER_HOST = "https://videorouter.sh/api/v1"
VIDEOROUTER_MIN_S, VIDEOROUTER_MAX_S = 3, 12
VIDEOROUTER_USD_PER_S = {
    "bytedance/seedance-2.5/fal": 0.08,
    "bytedance/seedance-2.0/fal": 0.06,
}


def videorouter_price(model: str, seconds: float) -> float | None:
    rate = VIDEOROUTER_USD_PER_S.get(model)
    if rate is None or not seconds or seconds <= 0:
        return None
    return round(rate * seconds, 4)


# ---------------------------------------------------------------- the registry (what the UI reads)

# ByteDance ModelArk is one account/key for both Seedance and Seedream; two regions, no workspace.
BYTEDANCE_REGIONS = {
    "intl": ("International (Singapore)", "https://ark.ap-southeast.bytepluses.com"),
    "cn": ("China (Beijing)", "https://ark.cn-beijing.volces.com"),
}

PROVIDERS: dict[str, dict] = {
    "wan": {
        "id": "wan",
        "name": "Alibaba Wan",
        "kind": "video",
        "needsWorkspace": True,
        "keyHint": "Alibaba Cloud Model Studio API key. Key, region and workspace must be from the same account.",
        "regions": [{"id": k, "name": v[0]} for k, v in WAN_REGIONS.items()],
        "models": [
            {"id": "wan3.0-video", "name": "Wan 3.0"},
            {"id": "wan3.0-video-prime", "name": "Wan 3.0 Prime (faster)"},
        ],
        "resolutions": ["480P", "720P", "1080P"],
        "ratios": ["9:16", "3:4", "1:1", "4:3", "16:9", "21:9", "adaptive"],
        "modes": ["text", "image", "reference"],
        "console": "https://modelstudio.console.alibabacloud.com/",
    },
    "seedance": {
        "id": "seedance",
        "name": "ByteDance Seedance",
        "kind": "video",
        "needsWorkspace": False,
        "keyHint": "BytePlus ModelArk API key (also works for Seedream). Pick the region your key is from.",
        "regions": [{"id": k, "name": v[0]} for k, v in BYTEDANCE_REGIONS.items()],
        "models": [
            {"id": "seedance-1.0-pro", "name": "Seedance 1.0 Pro"},
            {"id": "seedance-1.0-lite", "name": "Seedance 1.0 Lite (cheaper)"},
        ],
        "resolutions": ["480p", "720p", "1080p"],
        "ratios": ["9:16", "3:4", "1:1", "4:3", "16:9", "21:9"],
        "modes": ["text", "image"],  # a local reference video can't be sent to ByteDance (needs a hosted URL)
        "console": "https://console.byteplus.com/ark",
    },
    "argolink": {
        "id": "argolink",
        "name": "ArgoLink (Seedream 5.0)",
        "kind": "image",
        "needsWorkspace": False,
        "keyHint": "ArgoLink API key (argolink.io → Console → API Keys). One key, one account.",
        "regions": [{"id": "global", "name": "Global"}],
        "models": [{"id": "seedream-5.0-pro", "name": "Seedream 5.0 Pro"}],
        "sizes": ["1K", "2K"],
        "ratios": ["9:16", "3:4", "1:1", "4:3", "16:9", "2:3", "3:2", "5:4", "4:5", "21:9"],
        "modes": ["text", "image"],
        "console": "https://argolink.io/",
    },
    "seedream": {
        "id": "seedream",
        "name": "ByteDance Seedream (images)",
        "kind": "image",
        "needsWorkspace": False,
        "keyHint": "BytePlus ModelArk API key (the same key as Seedance). Pick the region your key is from.",
        "regions": [{"id": k, "name": v[0]} for k, v in BYTEDANCE_REGIONS.items()],
        "models": [
            {"id": "seedream-4.0", "name": "Seedream 4.0"},
            {"id": "seedream-3.0", "name": "Seedream 3.0"},
        ],
        "sizes": ["1K", "2K", "4K"],
        "ratios": ["9:16", "3:4", "1:1", "4:3", "16:9"],
        "modes": ["text", "image"],
        "console": "https://console.byteplus.com/ark",
    },
    "wavespeed": {
        "id": "wavespeed",
        "name": "WaveSpeed (Seedance 2.5)",
        "kind": "video",
        "needsWorkspace": False,
        "keyHint": "WaveSpeed API key (wavespeed.ai → API Keys). One key covers WaveSpeed's models.",
        "regions": [{"id": "global", "name": "Global"}],
        "models": [
            {"id": "seedance-2.5", "name": "Seedance 2.5"},
            {"id": "seedance-2.5-turbo", "name": "Seedance 2.5 Turbo (faster)"},
        ],
        "resolutions": ["480p", "720p", "1080p"],
        "ratios": ["9:16", "3:4", "1:1", "4:3", "16:9", "21:9"],
        "modes": ["text", "image"],
        "console": "https://wavespeed.ai/",
    },
    "videorouter": {
        "id": "videorouter",
        "name": "VideoRouter (Seedance 2.5)",
        "kind": "video",
        "needsWorkspace": False,
        "keyHint": "VideoRouter API key (videorouter.sh → API Keys), starts with llmr_sk_live_. One key covers its video models.",
        "regions": [{"id": "global", "name": "Global"}],
        "models": [
            {"id": "bytedance/seedance-2.5/fal", "name": "Seedance 2.5"},
            {"id": "bytedance/seedance-2.0/fal", "name": "Seedance 2.0 (cheaper)"},
        ],
        "resolutions": ["480p", "720p", "1080p"],
        "ratios": ["9:16", "3:4", "1:1", "4:3", "16:9", "21:9"],
        "modes": ["text", "image"],
        "console": "https://videorouter.sh/",
    },
}

DEFAULT_PROVIDER = "wan"


def provider(provider_id: str | None) -> dict:
    return PROVIDERS.get(provider_id or DEFAULT_PROVIDER) or PROVIDERS[DEFAULT_PROVIDER]


def is_bytedance(provider_id: str) -> bool:
    return provider_id in ("seedance", "seedream")


def kind_of(provider_id: str) -> str:
    return provider(provider_id).get("kind", "video")


def model_ids(provider_id: str) -> list[str]:
    return [m["id"] for m in provider(provider_id).get("models", [])]


def resolutions(provider_id: str) -> list[str]:
    p = provider(provider_id)
    return p.get("resolutions") or p.get("sizes") or []


def price(provider_id: str, model: str, region: str, resolution: str,
          seconds: float | None = None, images: int = 1) -> float | None:
    """The automatic price for one generation, in USD. None when it can't be worked out."""
    if provider_id == "wan":
        return wan_price(model, region, resolution, float(seconds or 0))
    if provider_id == "seedance":
        return seedance_price(model, resolution, float(seconds or 0))
    if provider_id == "seedream":
        return seedream_price(model, images)
    if provider_id == "argolink":
        return argolink_price(model, images)
    if provider_id == "wavespeed":
        return wavespeed_price(model, resolution, float(seconds or 0))
    if provider_id == "videorouter":
        return videorouter_price(model, float(seconds or 0))
    return None
