from __future__ import annotations

import asyncio
import logging
import math
from typing import TYPE_CHECKING, Awaitable, Callable

from app.models.schemas import GPSCoordinate, RouteStatus, SimulationState

if TYPE_CHECKING:
    from app.services.device_manager import DeviceManager

logger = logging.getLogger(__name__)

EARTH_RADIUS_M = 6_371_000  # 地球半徑（公尺）


def haversine_distance(coord1: GPSCoordinate, coord2: GPSCoordinate) -> float:
    """
    計算兩個 GPS 座標之間的距離（公尺）。
    使用 Haversine 公式，適用於短距離（< 數百公里）。
    """
    lat1 = math.radians(coord1.latitude)
    lat2 = math.radians(coord2.latitude)
    dlat = math.radians(coord2.latitude - coord1.latitude)
    dlng = math.radians(coord2.longitude - coord1.longitude)

    a = (
        math.sin(dlat / 2) ** 2
        + math.cos(lat1) * math.cos(lat2) * math.sin(dlng / 2) ** 2
    )
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))

    return EARTH_RADIUS_M * c


def calculate_gps_offset(
    current: GPSCoordinate,
    bearing_degrees: float,
    speed: float,
    elapsed_seconds: float,
) -> GPSCoordinate:
    """
    根據方位角與速度計算新的 GPS 座標。

    Args:
        current: 目前 GPS 座標
        bearing_degrees: 方位角，0 = 正北，順時針，單位：度
        speed: 速度（m/s）
        elapsed_seconds: 時間間隔（秒）

    Returns:
        新的 GPS 座標
    """
    distance = speed * elapsed_seconds
    bearing = math.radians(bearing_degrees)

    lat1 = math.radians(current.latitude)
    lng1 = math.radians(current.longitude)

    angular_distance = distance / EARTH_RADIUS_M

    lat2 = math.asin(
        math.sin(lat1) * math.cos(angular_distance)
        + math.cos(lat1) * math.sin(angular_distance) * math.cos(bearing)
    )
    lng2 = lng1 + math.atan2(
        math.sin(bearing) * math.sin(angular_distance) * math.cos(lat1),
        math.cos(angular_distance) - math.sin(lat1) * math.sin(lat2),
    )

    return GPSCoordinate(
        latitude=math.degrees(lat2),
        longitude=math.degrees(lng2),
    )


class RouteEngine:
    """路徑引擎：負責路徑插值計算與自動移動執行。"""

    def __init__(self, device_manager: DeviceManager) -> None:
        self._device_manager = device_manager
        self._state = SimulationState.IDLE
        self._current_position: GPSCoordinate | None = None
        self._progress: float = 0.0
        self._device_id: str | None = None

        self._task: asyncio.Task | None = None
        self._resume_event = asyncio.Event()
        self._stop_event = asyncio.Event()

    # ── 公開介面 ──────────────────────────────────────────────────────────────

    async def start_route(
        self,
        device_id: str,
        waypoints: list[GPSCoordinate],
        speed: float,
        loop: bool = False,
        on_position_update: Callable[[GPSCoordinate, float], Awaitable[None]] | None = None,
        on_route_error: Callable[[str], Awaitable[None]] | None = None,
    ) -> None:
        """啟動路徑自動移動（asyncio Task）。

        Args:
            device_id: 目標裝置 ID。
            waypoints: 路徑點序列（至少 2 個）。
            speed: 移動速度（m/s）。
            loop: 是否循環播放。
            on_position_update: 位置更新回呼 (coord, progress_ratio)。

        Raises:
            ValueError: 路徑點少於 2 個。
            RuntimeError: 已有路徑在執行中。
        """
        if len(waypoints) < 2:
            raise ValueError("路徑點至少需要 2 個")
        if self._state != SimulationState.IDLE:
            raise RuntimeError("已有路徑在執行中")

        route_waypoints = waypoints
        if self._current_position is not None:
            distance_to_start = haversine_distance(self._current_position, waypoints[0])
            if distance_to_start > 1.0:
                route_waypoints = [self._current_position, *waypoints]

        self._device_id = device_id
        self._progress = 0.0
        self._current_position = route_waypoints[0]
        self._stop_event.clear()
        self._resume_event.set()  # 確保不在暫停狀態

        self._state = SimulationState.MOVING
        self._task = asyncio.create_task(
            self._movement_loop(route_waypoints, speed, loop, on_position_update, on_route_error)
        )

    async def pause_route(self) -> None:
        """暫停路徑移動（MOVING → PAUSED）。"""
        if self._state == SimulationState.MOVING:
            self._state = SimulationState.PAUSED
            self._resume_event.clear()
            logger.info("路徑已暫停")

    async def resume_route(self) -> None:
        """繼續路徑移動（PAUSED → MOVING）。"""
        if self._state == SimulationState.PAUSED:
            self._state = SimulationState.MOVING
            self._resume_event.set()
            logger.info("路徑已繼續")

    async def stop_route(self) -> None:
        """停止路徑移動（MOVING/PAUSED → IDLE）。"""
        if self._state in (SimulationState.MOVING, SimulationState.PAUSED):
            self._stop_event.set()
            self._resume_event.set()
            if self._task is not None and not self._task.done():
                self._task.cancel()
                try:
                    await asyncio.wait_for(asyncio.shield(self._task), timeout=0.5)
                except (asyncio.TimeoutError, asyncio.CancelledError, Exception):
                    pass
            self._reset_state(clear_position=False)
            logger.info("路徑已停止")

    def get_status(self) -> RouteStatus:
        """回傳目前路徑狀態。"""
        return RouteStatus(
            state=self._state,
            current_position=self._current_position,
            progress=self._progress,
            device_id=self._device_id,
        )

    def sync_manual_position(self, device_id: str, coordinate: GPSCoordinate | None) -> None:
        """同步單點定位結果，讓 status API 與前端顯示保有最新位置。"""
        if self._state != SimulationState.IDLE:
            return
        self._device_id = device_id
        self._current_position = coordinate
        self._progress = 0.0

    # ── 靜態方法 ──────────────────────────────────────────────────────────────

    @staticmethod
    def interpolate_route(
        waypoints: list[GPSCoordinate],
        speed: float,
        update_interval: float = 1.0,
    ) -> list[tuple[GPSCoordinate, float]]:
        """
        將路徑點序列插值為細粒度座標序列。

        Args:
            waypoints: 路徑點序列（至少 2 個）
            speed: 移動速度（m/s）
            update_interval: 每次更新的時間間隔（秒）

        Returns:
            [(座標, 等待秒數), ...]
        """
        result: list[tuple[GPSCoordinate, float]] = []

        for i in range(len(waypoints) - 1):
            p1, p2 = waypoints[i], waypoints[i + 1]
            distance = haversine_distance(p1, p2)
            segment_time = distance / speed
            steps = max(1, math.ceil(segment_time / update_interval))
            wait_per_step = segment_time / steps

            for step in range(steps):
                t = step / steps
                coord = GPSCoordinate(
                    latitude=p1.latitude + t * (p2.latitude - p1.latitude),
                    longitude=p1.longitude + t * (p2.longitude - p1.longitude),
                )
                result.append((coord, wait_per_step))

        # 加入最後一個路徑點
        result.append((waypoints[-1], 0.0))
        return result

    # ── 內部方法 ──────────────────────────────────────────────────────────────

    async def _movement_loop(
        self,
        waypoints: list[GPSCoordinate],
        speed: float,
        loop: bool,
        on_position_update: Callable[[GPSCoordinate, float], Awaitable[None]] | None,
        on_route_error: Callable[[str], Awaitable[None]] | None,
    ) -> None:
        """路徑移動主迴圈，以 asyncio Task 執行。"""
        try:
            interpolated = self.interpolate_route(waypoints, speed)
            total_points = len(interpolated)

            while True:
                for idx, (coord, wait_time) in enumerate(interpolated):
                    # 檢查停止訊號
                    if self._stop_event.is_set():
                        return

                    # 等待 resume（暫停時阻塞）
                    await self._resume_event.wait()

                    # 再次確認停止（resume 後可能已 stop）
                    if self._stop_event.is_set():
                        return

                    # 確認裝置仍連線
                    if self._device_id and self._device_manager.get_device(self._device_id) is None:
                        logger.warning("裝置 %s 已斷線，強制停止路徑", self._device_id)
                        self._reset_state(clear_position=False)
                        return

                    # 設定 GPS 位置
                    try:
                        if self._device_id:
                            await self._device_manager.set_location(self._device_id, coord)
                    except Exception as exc:
                        logger.warning("set_location 失敗，停止路徑: %s", exc)
                        if on_route_error is not None:
                            try:
                                await on_route_error(str(exc))
                            except Exception:
                                pass
                        self._reset_state(clear_position=False)
                        return

                    # 更新狀態
                    self._current_position = coord
                    self._progress = idx / (total_points - 1) if total_points > 1 else 1.0

                    # 呼叫回呼
                    if on_position_update is not None:
                        try:
                            await on_position_update(coord, self._progress)
                        except Exception as exc:
                            logger.warning("on_position_update 回呼失敗: %s", exc)

                    # 等待對應時間間隔
                    if wait_time > 0:
                        try:
                            await asyncio.wait_for(
                                self._stop_event.wait(),
                                timeout=wait_time,
                            )
                            # stop_event 被設定，提前結束
                            return
                        except asyncio.TimeoutError:
                            pass  # 正常等待完畢，繼續下一點

                # 抵達終點
                self._progress = 1.0
                if on_position_update is not None and interpolated:
                    last_coord = interpolated[-1][0]
                    try:
                        await on_position_update(last_coord, 1.0)
                    except Exception as exc:
                        logger.warning("on_position_update 回呼失敗: %s", exc)

                if loop and not self._stop_event.is_set():
                    # 循環模式：重新開始
                    logger.info("路徑循環，重新開始")
                    self._progress = 0.0
                    continue
                else:
                    break

        except asyncio.CancelledError:
            logger.info("路徑移動 Task 被取消")
            raise
        finally:
            # 若非外部呼叫 stop_route，自行轉為 IDLE
            if self._state != SimulationState.IDLE:
                self._reset_state(clear_position=False)

    def _reset_state(self, *, clear_position: bool = True) -> None:
        """重置狀態機至 IDLE。"""
        self._state = SimulationState.IDLE
        self._progress = 0.0
        self._device_id = None
        if clear_position:
            self._current_position = None
        self._stop_event.clear()
        self._resume_event.set()
