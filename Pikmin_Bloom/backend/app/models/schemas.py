from __future__ import annotations

from enum import Enum

from pydantic import BaseModel, Field


class GPSCoordinate(BaseModel):
    latitude: float = Field(..., ge=-90, le=90)
    longitude: float = Field(..., ge=-180, le=180)


class DeviceInfo(BaseModel):
    id: str
    name: str
    is_connected: bool
    model: str | None = None
    developer_mode_enabled: bool | None = None


class SetLocationRequest(BaseModel):
    latitude: float = Field(..., ge=-90, le=90)
    longitude: float = Field(..., ge=-180, le=180)
    device_id: str


class RouteRequest(BaseModel):
    device_id: str
    waypoints: list[GPSCoordinate] = Field(..., min_length=2)
    speed: float = Field(..., ge=0.1, le=15.0)  # m/s
    loop: bool = False


class SimulationState(str, Enum):
    IDLE = "idle"
    MOVING = "moving"
    PAUSED = "paused"


class RouteStatus(BaseModel):
    state: SimulationState
    current_position: GPSCoordinate | None = None
    progress: float = 0.0  # 0.0 ~ 1.0
    device_id: str | None = None


class StatusUpdate(BaseModel):
    """WebSocket 推送訊息"""
    type: str  # "position" | "status" | "device"
    data: dict


class ErrorResponse(BaseModel):
    error: str
    code: str  # "DEVICE_NOT_FOUND" | "LOCATION_SET_FAILED" | "INVALID_COORDINATE" 等


class PostcardNearbyRequest(BaseModel):
    latitude: float = Field(..., ge=-90, le=90)
    longitude: float = Field(..., ge=-180, le=180)
    radius_m: int = Field(1000, ge=100, le=120000)
    limit: int = Field(80, ge=1, le=500)


class PostcardBoundsRequest(BaseModel):
    north: float = Field(..., ge=-90, le=90)
    south: float = Field(..., ge=-90, le=90)
    east: float = Field(..., ge=-180, le=180)
    west: float = Field(..., ge=-180, le=180)
    limit: int = Field(300, ge=1, le=500)


class PostcardLandmark(BaseModel):
    id: str
    name: str
    coordinate: GPSCoordinate
    image_url: str
    tags: list[str] = []
    distance_m: float | None = None
    holder_count: int = 0
    source: str = "atlas"
    postcard_type: str | None = None
    city: str | None = None
    country: str | None = None
    is_ai_detected: bool = False
    uploader_name: str | None = None
    created_at: str | None = None
