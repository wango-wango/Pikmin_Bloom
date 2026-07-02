from __future__ import annotations

import json
import time
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.models.schemas import GPSCoordinate

router = APIRouter()

DATA_DIR = Path(__file__).resolve().parents[1] / "data"
DATA_FILE = DATA_DIR / "routes.json"


class SavedRoute(BaseModel):
    id: str
    name: str = Field(..., min_length=1)
    waypoints: list[GPSCoordinate] = Field(..., min_length=2)
    createdAt: str
    updatedAt: str


class SavedRouteCreateRequest(BaseModel):
    name: str = Field(..., min_length=1)
    waypoints: list[GPSCoordinate] = Field(..., min_length=2)


class SavedRouteUpdateRequest(BaseModel):
    name: str = Field(..., min_length=1)
    waypoints: list[GPSCoordinate] = Field(..., min_length=2)


def _now_text() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")


def _clean_name(name: str) -> str:
    cleaned = name.strip()
    if not cleaned:
        raise HTTPException(status_code=400, detail={"error": "Route name is required", "code": "ROUTE_NAME_REQUIRED"})
    return cleaned


def _read_routes() -> list[SavedRoute]:
    if not DATA_FILE.exists():
        return []
    raw = DATA_FILE.read_text(encoding="utf-8")
    if not raw.strip():
        return []
    data = json.loads(raw)
    if not isinstance(data, list):
        return []
    return [SavedRoute.model_validate(item) for item in data]


def _write_routes(routes: list[SavedRoute]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    payload = [item.model_dump() for item in routes]
    DATA_FILE.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


@router.get("", response_model=list[SavedRoute])
async def list_saved_routes() -> list[SavedRoute]:
    return _read_routes()


@router.post("", response_model=SavedRoute)
async def create_saved_route(req: SavedRouteCreateRequest) -> SavedRoute:
    routes = _read_routes()
    timestamp = _now_text()
    item = SavedRoute(
        id=f"{int(time.time() * 1000)}-{len(routes) + 1}",
        name=_clean_name(req.name),
        waypoints=req.waypoints,
        createdAt=timestamp,
        updatedAt=timestamp,
    )
    routes.insert(0, item)
    _write_routes(routes)
    return item


@router.put("/{route_id}", response_model=SavedRoute)
async def update_saved_route(route_id: str, req: SavedRouteUpdateRequest) -> SavedRoute:
    routes = _read_routes()
    for index, item in enumerate(routes):
        if item.id != route_id:
            continue
        updated = SavedRoute(
            id=item.id,
            name=_clean_name(req.name),
            waypoints=req.waypoints,
            createdAt=item.createdAt,
            updatedAt=_now_text(),
        )
        routes[index] = updated
        _write_routes(routes)
        return updated
    raise HTTPException(status_code=404, detail={"error": "Saved route not found", "code": "SAVED_ROUTE_NOT_FOUND"})


@router.delete("/{route_id}")
async def delete_saved_route(route_id: str) -> dict:
    routes = _read_routes()
    next_items = [item for item in routes if item.id != route_id]
    _write_routes(next_items)
    return {"success": True}
