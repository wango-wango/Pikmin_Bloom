from __future__ import annotations

import json
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.models.schemas import GPSCoordinate

router = APIRouter()

DATA_DIR = Path(__file__).resolve().parents[1] / "data"
DATA_FILE = DATA_DIR / "landmarks.json"


class Landmark(BaseModel):
    id: str
    name: str = Field(..., min_length=1)
    coordinate: GPSCoordinate
    landmarkType: Literal["flower", "mushroom", "postcard"] = "mushroom"
    region: str = Field(default="未分類")
    tags: list[str] = Field(default=[])


class LandmarkCreateRequest(BaseModel):
    name: str = Field(..., min_length=1)
    coordinate: GPSCoordinate
    landmarkType: Literal["flower", "mushroom", "postcard"] = "mushroom"
    region: str = Field(default="未分類")
    tags: list[str] = Field(default=[])


class LandmarkUpdateRequest(BaseModel):
    name: str = Field(..., min_length=1)
    coordinate: GPSCoordinate
    landmarkType: Literal["flower", "mushroom", "postcard"] = "mushroom"
    region: str = Field(default="未分類")
    tags: list[str] = Field(default=[])


def _read_landmarks() -> list[Landmark]:
    if not DATA_FILE.exists():
        return []
    raw = DATA_FILE.read_text(encoding="utf-8")
    if not raw.strip():
        return []
    data = json.loads(raw)
    if not isinstance(data, list):
        return []
    return [Landmark.model_validate(item) for item in data]


def _write_landmarks(landmarks: list[Landmark]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    payload = [item.model_dump() for item in landmarks]
    DATA_FILE.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


@router.get("", response_model=list[Landmark])
async def list_landmarks() -> list[Landmark]:
    return _read_landmarks()


@router.post("", response_model=Landmark)
async def create_landmark(req: LandmarkCreateRequest) -> Landmark:
    landmarks = _read_landmarks()
    new_id = f"{int(__import__('time').time() * 1000)}-{len(landmarks) + 1}"
    item = Landmark(
        id=new_id,
        name=req.name.strip(),
        coordinate=req.coordinate,
        landmarkType=req.landmarkType,
        region=req.region,
        tags=req.tags,
    )
    landmarks.insert(0, item)
    _write_landmarks(landmarks)
    return item


@router.put("/{landmark_id}", response_model=Landmark)
async def update_landmark(landmark_id: str, req: LandmarkUpdateRequest) -> Landmark:
    landmarks = _read_landmarks()
    for index, item in enumerate(landmarks):
        if item.id != landmark_id:
            continue
        updated = Landmark(
            id=item.id,
            name=req.name.strip(),
            coordinate=req.coordinate,
            landmarkType=req.landmarkType,
            region=req.region,
            tags=req.tags,
        )
        landmarks[index] = updated
        _write_landmarks(landmarks)
        return updated
    raise HTTPException(status_code=404, detail={"error": "Landmark not found", "code": "LANDMARK_NOT_FOUND"})


@router.delete("/{landmark_id}")
async def delete_landmark(landmark_id: str) -> dict:
    landmarks = _read_landmarks()
    next_items = [item for item in landmarks if item.id != landmark_id]
    _write_landmarks(next_items)
    return {"success": True}
