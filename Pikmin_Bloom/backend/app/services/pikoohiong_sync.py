from __future__ import annotations

import argparse
import json
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

DATA_DIR = Path(__file__).resolve().parents[1] / "data"
DATA_FILE = DATA_DIR / "pikoohiong_postcards.json"
API_URL = "https://pikoohiong.com/api/postcards"


def _fetch_page(offset: int, page_size: int) -> dict[str, Any]:
    query = urllib.parse.urlencode(
        {
            "north": 90,
            "south": -90,
            "east": 180,
            "west": -180,
            "pageSize": page_size,
            "offset": offset,
        }
    )
    request = urllib.request.Request(
        f"{API_URL}?{query}",
        headers={
            "Accept": "application/json",
            "User-Agent": "pikomin-local-cache/1.0",
        },
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.loads(response.read().decode("utf-8"))


def _clean_item(item: dict[str, Any]) -> dict[str, Any] | None:
    lat = item.get("latitude")
    lng = item.get("longitude")
    image_url = item.get("displayImageUrl") or item.get("thumbnailImageUrl") or item.get("imageUrl")
    title = item.get("title")
    item_id = item.get("id")
    if item_id is None or title is None or lat is None or lng is None or not image_url:
        return None

    try:
        latitude = float(lat)
        longitude = float(lng)
    except (TypeError, ValueError):
        return None

    tags = item.get("tags")
    if not isinstance(tags, list):
        tags = []

    return {
        "id": str(item_id),
        "name": str(title),
        "latitude": latitude,
        "longitude": longitude,
        "imageUrl": str(image_url),
        "thumbnailImageUrl": str(item.get("thumbnailImageUrl") or image_url),
        "postcardType": str(item.get("postcardType") or "UNKNOWN"),
        "tags": [str(tag) for tag in tags],
        "city": item.get("city"),
        "country": item.get("country"),
        "isAiDetected": bool(item.get("isAiDetected")),
        "uploaderName": item.get("uploaderName"),
        "createdAt": item.get("createdAt"),
        "source": "pikoohiong",
    }


def sync_postcards(page_size: int = 100, delay_seconds: float = 0.6) -> dict[str, Any]:
    items: list[dict[str, Any]] = []
    seen: set[str] = set()
    offset = 0
    total: int | None = None

    while True:
        payload = _fetch_page(offset, page_size)
        raw_items = payload.get("items")
        if not isinstance(raw_items, list):
            raw_items = []

        if total is None and isinstance(payload.get("total"), int):
            total = payload["total"]

        for raw_item in raw_items:
            if not isinstance(raw_item, dict):
                continue
            item = _clean_item(raw_item)
            if item is None or item["id"] in seen:
                continue
            seen.add(item["id"])
            items.append(item)

        offset += len(raw_items)
        has_more = bool(payload.get("hasMore"))
        if not has_more or not raw_items:
            break
        if total is not None and offset >= total:
            break
        time.sleep(delay_seconds)

    output = {
        "source": "pikoohiong",
        "syncedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "total": total if total is not None else len(items),
        "count": len(items),
        "items": items,
    }
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    DATA_FILE.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
    return output


def main() -> None:
    parser = argparse.ArgumentParser(description="Sync pikoohiong postcard metadata into local cache.")
    parser.add_argument("--page-size", type=int, default=100)
    parser.add_argument("--delay", type=float, default=0.6)
    args = parser.parse_args()
    result = sync_postcards(page_size=max(1, args.page_size), delay_seconds=max(0, args.delay))
    print(f"Synced {result['count']} / {result['total']} pikoohiong postcards to {DATA_FILE}")


if __name__ == "__main__":
    main()
