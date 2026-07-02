from __future__ import annotations

import asyncio
import json
import math
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException

from app.models.schemas import GPSCoordinate, PostcardBoundsRequest, PostcardLandmark, PostcardNearbyRequest

router = APIRouter()

ATLAS_NEARBY_URL = "https://pikmin-atlas.com/api/postcards/nearby"
DATA_DIR = Path(__file__).resolve().parents[1] / "data"
PIKOOHIONG_CACHE_FILE = DATA_DIR / "pikoohiong_postcards.json"
CACHE_TTL_SECONDS = 90
_nearby_cache: dict[str, tuple[float, list[PostcardLandmark]]] = {}


def _cache_key(req: PostcardNearbyRequest) -> str:
    # Quantize to reduce duplicate requests while panning slightly.
    lat = round(req.latitude, 4)
    lng = round(req.longitude, 4)
    radius = int(round(req.radius_m / 250) * 250)
    return f"{lat}:{lng}:{radius}:{req.limit}"


def _bounds_cache_key(req: PostcardBoundsRequest) -> str:
    north = round(req.north, 4)
    south = round(req.south, 4)
    east = round(req.east, 4)
    west = round(req.west, 4)
    return f"bounds:{north}:{south}:{east}:{west}:{req.limit}"


def _normalize_postcard(item: dict[str, Any]) -> PostcardLandmark | None:
    lat = item.get("latitude", item.get("lat"))
    lng = item.get("longitude", item.get("lng"))
    image_url = item.get("image_url") or item.get("imageUrl")
    guid = item.get("guid") or item.get("id")
    name = item.get("name") or "未命名明信片"
    if guid is None or lat is None or lng is None or not image_url:
        return None

    try:
        coordinate = GPSCoordinate(latitude=float(lat), longitude=float(lng))
    except Exception:
        return None

    tags = item.get("tags") or []
    if not isinstance(tags, list):
        tags = []

    return PostcardLandmark(
        id=str(guid),
        name=str(name),
        coordinate=coordinate,
        image_url=str(image_url),
        tags=[str(tag) for tag in tags],
        distance_m=item.get("distance_m"),
        holder_count=int(item.get("holder_count") or 0),
    )


def _fetch_nearby_from_atlas(req: PostcardNearbyRequest) -> list[PostcardLandmark]:
    payload = json.dumps(
        {
            "user_lat": req.latitude,
            "user_lng": req.longitude,
            "radius_m": req.radius_m,
            "limit": req.limit,
        }
    ).encode("utf-8")
    request = urllib.request.Request(
        ATLAS_NEARBY_URL,
        data=payload,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "pikomin-local-dev/1.0",
        },
    )
    with urllib.request.urlopen(request, timeout=12) as response:
        data = json.loads(response.read().decode("utf-8"))

    if not isinstance(data, list):
        return []

    postcards: list[PostcardLandmark] = []
    seen: set[str] = set()
    for item in data:
        if not isinstance(item, dict):
            continue
        postcard = _normalize_postcard(item)
        if postcard is None or postcard.id in seen:
            continue
        seen.add(postcard.id)
        postcards.append(postcard)
    return postcards


def _distance_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    radius = 6371000
    d_lat = math.radians(lat2 - lat1)
    d_lng = math.radians(lng2 - lng1)
    a = (
        math.sin(d_lat / 2) ** 2
        + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(d_lng / 2) ** 2
    )
    return radius * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def _in_bounds(postcard: PostcardLandmark, req: PostcardBoundsRequest) -> bool:
    coord = postcard.coordinate
    return (
        req.south <= coord.latitude <= req.north
        and req.west <= coord.longitude <= req.east
    )


def _normalize_pikoohiong_item(item: dict[str, Any]) -> PostcardLandmark | None:
    item_id = item.get("id")
    name = item.get("name") or item.get("title")
    lat = item.get("latitude")
    lng = item.get("longitude")
    image_url = item.get("imageUrl") or item.get("thumbnailImageUrl")
    if item_id is None or name is None or lat is None or lng is None or not image_url:
        return None

    try:
        coordinate = GPSCoordinate(latitude=float(lat), longitude=float(lng))
    except Exception:
        return None

    tags = item.get("tags") or []
    if not isinstance(tags, list):
        tags = []

    return PostcardLandmark(
        id=f"pikoohiong:{item_id}",
        name=str(name),
        coordinate=coordinate,
        image_url=str(image_url),
        tags=[str(tag) for tag in tags],
        holder_count=0,
        source="pikoohiong",
        postcard_type=str(item.get("postcardType")) if item.get("postcardType") else None,
        city=str(item.get("city")) if item.get("city") else None,
        country=str(item.get("country")) if item.get("country") else None,
        is_ai_detected=bool(item.get("isAiDetected")),
        uploader_name=str(item.get("uploaderName")) if item.get("uploaderName") else None,
        created_at=str(item.get("createdAt")) if item.get("createdAt") else None,
    )


def _fetch_pikoohiong_bounds_from_cache(req: PostcardBoundsRequest) -> list[PostcardLandmark]:
    if not PIKOOHIONG_CACHE_FILE.exists():
        return []

    data = json.loads(PIKOOHIONG_CACHE_FILE.read_text(encoding="utf-8"))
    raw_items = data.get("items") if isinstance(data, dict) else []
    if not isinstance(raw_items, list):
        return []

    postcards: list[PostcardLandmark] = []
    for raw_item in raw_items:
        if not isinstance(raw_item, dict):
            continue
        postcard = _normalize_pikoohiong_item(raw_item)
        if postcard is None or not _in_bounds(postcard, req):
            continue
        postcards.append(postcard)
        if len(postcards) >= req.limit:
            break
    return postcards


def _fetch_bounds_from_atlas(req: PostcardBoundsRequest) -> list[PostcardLandmark]:
    if req.south > req.north or req.west > req.east:
        return []

    lat_span = req.north - req.south
    lng_span = req.east - req.west
    grid_size = 2 if max(lat_span, lng_span) < 0.035 else 3
    per_tile_limit = max(30, min(90, math.ceil(req.limit / (grid_size * grid_size)) + 15))
    lat_step = lat_span / grid_size
    lng_step = lng_span / grid_size
    tile_radius = _distance_m(
        req.south,
        req.west,
        req.south + lat_step,
        req.west + lng_step,
    ) / 2 * 1.35

    merged: dict[str, PostcardLandmark] = {}
    for row in range(grid_size):
        for col in range(grid_size):
            lat = req.south + lat_step * (row + 0.5)
            lng = req.west + lng_step * (col + 0.5)
            nearby_req = PostcardNearbyRequest(
                latitude=lat,
                longitude=lng,
                radius_m=max(300, min(120000, int(tile_radius))),
                limit=per_tile_limit,
            )
            for postcard in _fetch_nearby_from_atlas(nearby_req):
                if _in_bounds(postcard, req):
                    merged[postcard.id] = postcard

    return list(merged.values())[: req.limit]


@router.post("/nearby", response_model=list[PostcardLandmark])
async def get_nearby_postcards(req: PostcardNearbyRequest) -> list[PostcardLandmark]:
    key = _cache_key(req)
    cached = _nearby_cache.get(key)
    now = time.time()
    if cached and now - cached[0] < CACHE_TTL_SECONDS:
        return cached[1]

    try:
        postcards = await asyncio.to_thread(_fetch_nearby_from_atlas, req)
    except urllib.error.HTTPError as exc:
        raise HTTPException(
            status_code=502,
            detail={"error": f"Pikmin Atlas 回應錯誤：HTTP {exc.code}", "code": "POSTCARD_ATLAS_FAILED"},
        ) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=502,
            detail={"error": "無法取得 Pikmin Atlas 明信片資料", "code": "POSTCARD_ATLAS_FAILED"},
        ) from exc

    _nearby_cache[key] = (now, postcards)
    return postcards


@router.post("/pikoohiong/bounds", response_model=list[PostcardLandmark])
async def get_pikoohiong_postcards_in_bounds(req: PostcardBoundsRequest) -> list[PostcardLandmark]:
    key = f"pikoohiong:{_bounds_cache_key(req)}"
    cached = _nearby_cache.get(key)
    now = time.time()
    if cached and now - cached[0] < CACHE_TTL_SECONDS:
        return cached[1]

    try:
        postcards = await asyncio.to_thread(_fetch_pikoohiong_bounds_from_cache, req)
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail={"error": "無法讀取 pikoohiong 明信片快取", "code": "POSTCARD_PIKOOHIONG_CACHE_FAILED"},
        ) from exc

    _nearby_cache[key] = (now, postcards)
    return postcards


@router.post("/bounds", response_model=list[PostcardLandmark])
async def get_postcards_in_bounds(req: PostcardBoundsRequest) -> list[PostcardLandmark]:
    key = _bounds_cache_key(req)
    cached = _nearby_cache.get(key)
    now = time.time()
    if cached and now - cached[0] < CACHE_TTL_SECONDS:
        return cached[1]

    try:
        postcards = await asyncio.to_thread(_fetch_bounds_from_atlas, req)
    except urllib.error.HTTPError as exc:
        raise HTTPException(
            status_code=502,
            detail={"error": f"Pikmin Atlas 回應錯誤：HTTP {exc.code}", "code": "POSTCARD_ATLAS_FAILED"},
        ) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=502,
            detail={"error": "無法取得 Pikmin Atlas 明信片資料", "code": "POSTCARD_ATLAS_FAILED"},
        ) from exc

    _nearby_cache[key] = (now, postcards)
    return postcards
