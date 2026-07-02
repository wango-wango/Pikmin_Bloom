"""
任務 3.1 單元測試：haversine_distance、interpolate_route、calculate_gps_offset
"""
import math

import pytest

from app.models.schemas import GPSCoordinate
from app.services.route_engine import (
    EARTH_RADIUS_M,
    RouteEngine,
    calculate_gps_offset,
    haversine_distance,
)


# ---------------------------------------------------------------------------
# haversine_distance
# ---------------------------------------------------------------------------

class TestHaversineDistance:
    def test_same_point_is_zero(self):
        p = GPSCoordinate(latitude=25.0, longitude=121.5)
        assert haversine_distance(p, p) == 0.0

    def test_symmetry(self):
        p1 = GPSCoordinate(latitude=25.0, longitude=121.5)
        p2 = GPSCoordinate(latitude=25.1, longitude=121.6)
        assert haversine_distance(p1, p2) == pytest.approx(haversine_distance(p2, p1))

    def test_non_negative(self):
        p1 = GPSCoordinate(latitude=-10.0, longitude=50.0)
        p2 = GPSCoordinate(latitude=10.0, longitude=-50.0)
        assert haversine_distance(p1, p2) >= 0.0

    def test_known_distance_taipei_to_tokyo(self):
        # 台北 (25.033, 121.565) → 東京 (35.689, 139.692) ≈ 2100 km
        taipei = GPSCoordinate(latitude=25.033, longitude=121.565)
        tokyo = GPSCoordinate(latitude=35.689, longitude=139.692)
        dist = haversine_distance(taipei, tokyo)
        assert 2_050_000 < dist < 2_150_000  # 公尺

    def test_one_degree_latitude_approx_111km(self):
        p1 = GPSCoordinate(latitude=0.0, longitude=0.0)
        p2 = GPSCoordinate(latitude=1.0, longitude=0.0)
        dist = haversine_distance(p1, p2)
        # 1 度緯度 ≈ 111,195 m
        assert abs(dist - 111_195) < 500


# ---------------------------------------------------------------------------
# interpolate_route
# ---------------------------------------------------------------------------

class TestInterpolateRoute:
    def test_two_waypoints_returns_at_least_two_points(self):
        p1 = GPSCoordinate(latitude=25.0, longitude=121.5)
        p2 = GPSCoordinate(latitude=25.1, longitude=121.5)
        result = RouteEngine.interpolate_route([p1, p2], speed=5.0)
        assert len(result) >= 2

    def test_last_point_is_final_waypoint(self):
        p1 = GPSCoordinate(latitude=25.0, longitude=121.5)
        p2 = GPSCoordinate(latitude=25.1, longitude=121.5)
        result = RouteEngine.interpolate_route([p1, p2], speed=5.0)
        last_coord, last_wait = result[-1]
        assert last_coord.latitude == pytest.approx(p2.latitude)
        assert last_coord.longitude == pytest.approx(p2.longitude)
        assert last_wait == 0.0

    def test_total_time_equals_distance_over_speed(self):
        p1 = GPSCoordinate(latitude=25.0, longitude=121.5)
        p2 = GPSCoordinate(latitude=25.1, longitude=121.5)
        speed = 3.0
        result = RouteEngine.interpolate_route([p1, p2], speed=speed)
        total_time = sum(wait for _, wait in result)
        expected_time = haversine_distance(p1, p2) / speed
        assert abs(total_time - expected_time) < 0.001

    def test_three_waypoints(self):
        p1 = GPSCoordinate(latitude=25.0, longitude=121.5)
        p2 = GPSCoordinate(latitude=25.05, longitude=121.5)
        p3 = GPSCoordinate(latitude=25.1, longitude=121.5)
        speed = 5.0
        result = RouteEngine.interpolate_route([p1, p2, p3], speed=speed)
        total_time = sum(wait for _, wait in result)
        expected_time = (
            haversine_distance(p1, p2) + haversine_distance(p2, p3)
        ) / speed
        assert abs(total_time - expected_time) < 0.001

    def test_update_interval_affects_step_count(self):
        p1 = GPSCoordinate(latitude=25.0, longitude=121.5)
        p2 = GPSCoordinate(latitude=25.1, longitude=121.5)
        speed = 5.0
        result_1s = RouteEngine.interpolate_route([p1, p2], speed=speed, update_interval=1.0)
        result_2s = RouteEngine.interpolate_route([p1, p2], speed=speed, update_interval=2.0)
        # 較小的 update_interval 應產生更多插值點
        assert len(result_1s) >= len(result_2s)


# ---------------------------------------------------------------------------
# calculate_gps_offset
# ---------------------------------------------------------------------------

class TestCalculateGpsOffset:
    def test_north_bearing_increases_latitude(self):
        current = GPSCoordinate(latitude=25.0, longitude=121.5)
        new_coord = calculate_gps_offset(current, bearing_degrees=0.0, speed=10.0, elapsed_seconds=1.0)
        assert new_coord.latitude > current.latitude
        assert abs(new_coord.longitude - current.longitude) < 1e-6

    def test_south_bearing_decreases_latitude(self):
        current = GPSCoordinate(latitude=25.0, longitude=121.5)
        new_coord = calculate_gps_offset(current, bearing_degrees=180.0, speed=10.0, elapsed_seconds=1.0)
        assert new_coord.latitude < current.latitude

    def test_east_bearing_increases_longitude(self):
        current = GPSCoordinate(latitude=0.0, longitude=0.0)
        new_coord = calculate_gps_offset(current, bearing_degrees=90.0, speed=10.0, elapsed_seconds=1.0)
        assert new_coord.longitude > current.longitude

    def test_distance_matches_speed_times_time(self):
        current = GPSCoordinate(latitude=25.0, longitude=121.5)
        speed = 5.0
        elapsed = 0.2
        new_coord = calculate_gps_offset(current, bearing_degrees=45.0, speed=speed, elapsed_seconds=elapsed)
        actual_dist = haversine_distance(current, new_coord)
        expected_dist = speed * elapsed
        assert abs(actual_dist - expected_dist) < 1.0  # 誤差 < 1m

    def test_zero_elapsed_returns_same_position(self):
        current = GPSCoordinate(latitude=25.0, longitude=121.5)
        new_coord = calculate_gps_offset(current, bearing_degrees=90.0, speed=5.0, elapsed_seconds=0.0)
        assert new_coord.latitude == pytest.approx(current.latitude, abs=1e-9)
        assert new_coord.longitude == pytest.approx(current.longitude, abs=1e-9)


# ---------------------------------------------------------------------------
# RouteEngine 狀態機（任務 3.5）
# ---------------------------------------------------------------------------

import asyncio
from unittest.mock import AsyncMock, MagicMock

from app.models.schemas import RouteStatus, SimulationState
from app.services.route_engine import RouteEngine


def _make_engine(mock_mode: bool = True):
    """建立帶有 mock DeviceManager 的 RouteEngine。"""
    from app.services.device_manager import DeviceManager
    dm = DeviceManager(mock_mode=mock_mode)
    return RouteEngine(dm)


def _waypoints():
    return [
        GPSCoordinate(latitude=25.0, longitude=121.5),
        GPSCoordinate(latitude=25.001, longitude=121.5),
    ]


class TestRouteEngineStateMachine:
    def test_initial_state_is_idle(self):
        engine = _make_engine()
        status = engine.get_status()
        assert status.state == SimulationState.IDLE
        assert status.progress == 0.0
        assert status.current_position is None

    @pytest.mark.asyncio
    async def test_start_route_transitions_to_moving(self):
        engine = _make_engine()
        await engine.start_route("mock-device-001", _waypoints(), speed=5.0)
        assert engine.get_status().state == SimulationState.MOVING
        await engine.stop_route()

    @pytest.mark.asyncio
    async def test_pause_transitions_moving_to_paused(self):
        engine = _make_engine()
        await engine.start_route("mock-device-001", _waypoints(), speed=5.0)
        await engine.pause_route()
        assert engine.get_status().state == SimulationState.PAUSED
        await engine.stop_route()

    @pytest.mark.asyncio
    async def test_resume_transitions_paused_to_moving(self):
        engine = _make_engine()
        await engine.start_route("mock-device-001", _waypoints(), speed=5.0)
        await engine.pause_route()
        await engine.resume_route()
        assert engine.get_status().state == SimulationState.MOVING
        await engine.stop_route()

    @pytest.mark.asyncio
    async def test_stop_from_moving_transitions_to_idle(self):
        engine = _make_engine()
        await engine.start_route("mock-device-001", _waypoints(), speed=5.0)
        await engine.stop_route()
        assert engine.get_status().state == SimulationState.IDLE

    @pytest.mark.asyncio
    async def test_stop_from_paused_transitions_to_idle(self):
        engine = _make_engine()
        await engine.start_route("mock-device-001", _waypoints(), speed=5.0)
        await engine.pause_route()
        await engine.stop_route()
        assert engine.get_status().state == SimulationState.IDLE

    @pytest.mark.asyncio
    async def test_start_route_raises_if_already_running(self):
        engine = _make_engine()
        await engine.start_route("mock-device-001", _waypoints(), speed=5.0)
        with pytest.raises(RuntimeError):
            await engine.start_route("mock-device-001", _waypoints(), speed=5.0)
        await engine.stop_route()

    @pytest.mark.asyncio
    async def test_start_route_raises_with_less_than_two_waypoints(self):
        engine = _make_engine()
        with pytest.raises(ValueError):
            await engine.start_route(
                "mock-device-001",
                [GPSCoordinate(latitude=25.0, longitude=121.5)],
                speed=5.0,
            )

    @pytest.mark.asyncio
    async def test_on_position_update_callback_called(self):
        engine = _make_engine()
        updates: list[tuple[GPSCoordinate, float]] = []

        async def callback(coord: GPSCoordinate, progress: float) -> None:
            updates.append((coord, progress))

        await engine.start_route(
            "mock-device-001", _waypoints(), speed=100.0, on_position_update=callback
        )
        # 等待移動迴圈執行一段時間
        await asyncio.sleep(0.2)
        await engine.stop_route()
        assert len(updates) > 0

    @pytest.mark.asyncio
    async def test_route_completes_and_returns_to_idle(self):
        """短距離 + 高速，路徑應自動完成並回到 IDLE。"""
        engine = _make_engine()
        # 非常短的距離（幾乎同一點），高速，讓迴圈快速完成
        p1 = GPSCoordinate(latitude=25.0, longitude=121.5)
        p2 = GPSCoordinate(latitude=25.0000001, longitude=121.5)
        await engine.start_route("mock-device-001", [p1, p2], speed=10.0)
        # 等待路徑自然完成
        await asyncio.sleep(0.5)
        assert engine.get_status().state == SimulationState.IDLE

    @pytest.mark.asyncio
    async def test_loop_mode_restarts_after_completion(self):
        """loop=True 時，路徑完成後應重新開始（狀態保持 MOVING）。"""
        engine = _make_engine()
        p1 = GPSCoordinate(latitude=25.0, longitude=121.5)
        p2 = GPSCoordinate(latitude=25.0000001, longitude=121.5)
        await engine.start_route("mock-device-001", [p1, p2], speed=10.0, loop=True)
        # 等待至少一個循環完成
        await asyncio.sleep(0.3)
        # 仍應在 MOVING 狀態（循環中）
        assert engine.get_status().state == SimulationState.MOVING
        await engine.stop_route()

    @pytest.mark.asyncio
    async def test_device_disconnect_forces_idle(self):
        """裝置斷線時，路徑應強制轉為 IDLE。"""
        from app.services.device_manager import DeviceManager
        dm = DeviceManager(mock_mode=True)
        engine = RouteEngine(dm)

        # 讓 get_device 回傳 None 模擬斷線
        dm.get_device = MagicMock(return_value=None)

        await engine.start_route("mock-device-001", _waypoints(), speed=5.0)
        await asyncio.sleep(0.3)
        assert engine.get_status().state == SimulationState.IDLE

    @pytest.mark.asyncio
    async def test_pause_does_nothing_when_idle(self):
        engine = _make_engine()
        await engine.pause_route()  # 不應拋出例外
        assert engine.get_status().state == SimulationState.IDLE

    @pytest.mark.asyncio
    async def test_resume_does_nothing_when_idle(self):
        engine = _make_engine()
        await engine.resume_route()  # 不應拋出例外
        assert engine.get_status().state == SimulationState.IDLE

    @pytest.mark.asyncio
    async def test_stop_does_nothing_when_idle(self):
        engine = _make_engine()
        await engine.stop_route()  # 不應拋出例外
        assert engine.get_status().state == SimulationState.IDLE
