# pyrefly: ignore [missing-import]
from fastapi import APIRouter, Request, Query
import urllib.request
import urllib.parse
import json

router = APIRouter()

@router.get("")
async def get_geolocation(request: Request) -> dict:
    """用 IP 估算目前位置（不精確，誤差可能數公里）。"""
    try:
        with urllib.request.urlopen("http://ip-api.com/json/?fields=lat,lon,city", timeout=5) as resp:
            data = json.loads(resp.read())
            return {"latitude": data["lat"], "longitude": data["lon"], "city": data.get("city", "")}
    except Exception:
        # 備用：台北市中心
        return {"latitude": 25.0330, "longitude": 121.5654, "city": "台北（預設）"}

@router.get("/search")
async def search_geolocation(q: str = Query(..., min_length=1)) -> list[dict]:
    """使用 OSM Nominatim API 搜尋地名。"""
    try:
        query = urllib.parse.quote(q)
        url = f"https://nominatim.openstreetmap.org/search?q={query}&format=json&limit=5&accept-language=zh-TW,en"
        
        req = urllib.request.Request(url, headers={'User-Agent': 'PikminBloomController/1.0'})
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read())
            results = []
            for item in data:
                results.append({
                    "name": item.get("display_name", ""),
                    "latitude": float(item.get("lat", 0)),
                    "longitude": float(item.get("lon", 0))
                })
            return results
    except Exception as e:
        print(f"Search failed: {e}")
        return []
