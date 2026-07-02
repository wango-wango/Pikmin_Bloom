# 實作計畫：iOS GPS 模擬器

## 概覽

依照設計文件，以漸進式方式實作 iOS GPS 模擬器。
後端使用 Python 3.11+ / FastAPI，前端使用 React + TypeScript + Vite，整體以 Docker Compose 部署。

---

## 任務清單

- [x] 1. 後端基礎建設
  - [x] 1.1 建立後端專案結構與 Pydantic 資料模型
    - 建立 `backend/app/` 目錄結構（`main.py`、`routers/`、`services/`、`models/`）
    - 在 `backend/app/models/schemas.py` 實作所有 Pydantic 模型：`GPSCoordinate`、`DeviceInfo`、`SetLocationRequest`、`RouteRequest`、`SimulationState`、`RouteStatus`、`StatusUpdate`、`ErrorResponse`
    - 建立 `backend/requirements.txt`（fastapi、uvicorn、pymobiledevice3、hypothesis、pytest、pytest-asyncio）
    - _需求：5.2、5.7_

  - [ ]* 1.2 撰寫 Pydantic 模型的屬性測試
    - **屬性 4：GPS 座標驗證邊界正確性**
    - **驗證：需求 5.7**

  - [x] 1.3 建立 FastAPI 主程式與 CORS 設定
    - 在 `backend/app/main.py` 初始化 FastAPI app
    - 設定 CORS middleware，允許前端 origin（`http://localhost:3000`）
    - 掛載所有 Router 佔位（`/api/devices`、`/api/location`、`/api/route`、`/api/status`）
    - 設定 `/ws/status` WebSocket 端點佔位
    - _需求：5.1、5.2、5.3、5.4、5.5_

- [x] 2. 後端核心服務：DeviceManager
  - [x] 2.1 實作 `DeviceManager` 類別
    - 在 `backend/app/services/device_manager.py` 實作 `DeviceManager`
    - 實作 `list_devices()`、`set_location()`、`stop_simulation()`、`get_device()`
    - 實作 mock mode：`MOCK_MODE=true` 時回傳假裝置 `mock-device-001`，`set_location` 僅記錄 log
    - 實作 `start_device_polling()` asyncio 背景任務（每 5 秒掃描一次）
    - 實作 `_update_device_registry()` 比對新舊裝置清單，觸發連線/斷線事件
    - _需求：1.1、1.2、1.3、1.4、1.5、6.7_

  - [ ]* 2.2 撰寫 DeviceManager 單元測試
    - 測試 mock mode 行為（`list_devices` 回傳假裝置、`set_location` 不拋出例外）
    - 測試裝置斷線時停止 GPS 模擬
    - _需求：1.3、6.7_

- [x] 3. 後端核心服務：RouteEngine
  - [x] 3.1 實作 Haversine 距離函式與路徑插值
    - 在 `backend/app/services/route_engine.py` 實作 `haversine_distance(coord1, coord2) -> float`
    - 實作 `RouteEngine.interpolate_route(waypoints, speed, update_interval)` 靜態方法
    - 實作 `calculate_gps_offset(current, bearing_degrees, speed, elapsed_seconds)` 函式
    - _需求：3.3、3.4、4.2_

  - [ ]* 3.2 撰寫 Haversine 距離屬性測試
    - **屬性 2：Haversine 距離計算精度（非負、對稱、同點為零）**
    - **驗證：需求 3.3、3.4**

  - [ ]* 3.3 撰寫路徑時間間隔屬性測試
    - **屬性 1：路徑移動時間間隔計算正確性（總時間 = 距離 / 速度，誤差 < 0.001 秒）**
    - **驗證：需求 3.3**

  - [ ]* 3.4 撰寫搖桿 GPS 偏移屬性測試（後端）
    - **屬性 3：搖桿移動向量計算正確性（偏移距離誤差 < 1m）**
    - **驗證：需求 4.2**

  - [x] 3.5 實作 `RouteEngine` 狀態機與自動移動邏輯
    - 實作 `start_route()`、`pause_route()`、`resume_route()`、`stop_route()`
    - 實作狀態機：`IDLE → MOVING → PAUSED → MOVING → IDLE`
    - 以 asyncio Task 執行路徑移動迴圈，每個插值點呼叫 `DeviceManager.set_location()` 並等待對應時間間隔
    - 裝置斷線時任何狀態強制轉為 `IDLE`
    - _需求：3.3、3.4、3.6、3.7、3.8、3.10_

  - [ ]* 3.6 撰寫 RouteEngine 狀態機單元測試
    - 測試所有狀態轉換路徑
    - 測試循環模式（loop=true 時抵達終點後重新開始）
    - _需求：3.6、3.7、3.8、3.10_

- [x] 4. 後端 WebSocket Manager 與 API 路由
  - [x] 4.1 實作 `WebSocketManager`
    - 在 `backend/app/services/ws_manager.py` 實作 `connect()`、`disconnect()`、`broadcast()`
    - `broadcast` 對所有已連線客戶端發送 JSON 訊息，單一客戶端失敗不影響其他客戶端
    - _需求：3.5_

  - [x] 4.2 實作後端 API 路由
    - 在 `backend/app/routers/devices.py` 實作 `GET /api/devices`
    - 在 `backend/app/routers/location.py` 實作 `POST /api/location`（含 404 / 422 錯誤處理）
    - 在 `backend/app/routers/route.py` 實作 `POST /api/route/start`、`POST /api/route/pause`、`POST /api/route/stop`（含 409 衝突處理）
    - 在 `backend/app/routers/status.py` 實作 `GET /api/status`
    - 在 `main.py` 完成 `/ws/status` WebSocket 端點，整合 `WebSocketManager` 與 `RouteEngine` 位置更新回呼
    - _需求：5.1、5.2、5.3、5.4、5.5、5.6、5.7_

  - [ ]* 4.3 撰寫 API 路由整合測試
    - 使用 FastAPI TestClient + mock mode 測試所有端點
    - 測試 404（device_id 不存在）、422（座標超出範圍）、409（路徑已在執行）
    - _需求：5.6、5.7_

- [x] 5. 後端檢查點
  - 確認所有後端測試通過，如有問題請提出。

- [x] 6. 前端基礎建設
  - [x] 6.1 建立前端專案結構與 TypeScript 型別
    - 建立 `frontend/src/` 目錄結構（`components/`、`hooks/`、`api/`、`types/`）
    - 在 `frontend/src/types/index.ts` 定義所有 TypeScript 介面：`GPSCoordinate`、`DeviceInfo`、`SetLocationRequest`、`RouteRequest`、`SimulationState`、`RouteStatus`、`MoveVector`
    - 建立 `frontend/package.json`（react、typescript、vite、leaflet、nipplejs、vitest、fast-check）
    - _需求：2.1、3.1_

  - [x] 6.2 實作 API 客戶端
    - 在 `frontend/src/api/client.ts` 實作 `apiClient`：`getDevices()`、`setLocation()`、`startRoute()`、`pauseRoute()`、`stopRoute()`、`getStatus()`
    - 實作 `createStatusWebSocket(onMessage)` 函式，含指數退避自動重連（最多 5 次）
    - _需求：2.3、3.5、5.1、5.2、5.3、5.4、5.5_

- [x] 7. 前端自訂 Hooks
  - [x] 7.1 實作 `useDevice` Hook
    - 在 `frontend/src/hooks/useDevice.ts` 實作 `useDevice()`
    - 初始化時呼叫 `apiClient.getDevices()`，回傳 `devices`、`selectedDevice`、`selectDevice()`、`isLoading`、`error`
    - _需求：1.1、1.4_

  - [x] 7.2 實作 `useRoute` Hook
    - 在 `frontend/src/hooks/useRoute.ts` 實作 `useRoute()`
    - 管理 `waypoints` 陣列（`addWaypoint`、`removeWaypoint`、`clearWaypoints`）
    - 管理 `routeStatus`，透過 WebSocket 接收即時更新
    - 實作 `startRoute(speed, loop)`、`pauseRoute()`、`stopRoute()`
    - _需求：3.1、3.2、3.5、3.6、3.7、3.8、3.9_

- [x] 8. 前端 UI 元件
  - [x] 8.1 實作 `DeviceStatus` 元件
    - 在 `frontend/src/components/DeviceStatus.tsx` 實作裝置清單顯示、選擇下拉選單、連線狀態指示燈
    - 使用 `useDevice` Hook
    - _需求：1.1、1.4_

  - [x] 8.2 實作 `MapInterface` 元件
    - 在 `frontend/src/components/MapInterface.tsx` 實作 Leaflet 地圖（預設中心台灣 23.5, 121.0）
    - 根據 `VITE_GOOGLE_MAPS_API_KEY` 環境變數切換 Google Maps
    - 實作點選事件回呼 `onMapClick(coord)`、目前位置標記、路徑點標記與路徑線
    - Props：`mode: 'single' | 'route'`
    - _需求：2.1、2.2、2.6、3.1、3.5_

  - [x] 8.3 實作 `JoystickController` 元件
    - 在 `frontend/src/components/JoystickController.tsx` 實作虛擬搖桿（使用 nipplejs 或 Canvas）
    - 每 200ms throttle 發送 `onMove(vector: MoveVector)` 回呼
    - 放開搖桿時呼叫 `onRelease()`
    - Props：`speed: number`、`onMove`、`onRelease`
    - 搖桿啟動時若路徑自動移動進行中，呼叫 `pauseRoute()`
    - _需求：4.1、4.2、4.3、4.4、4.6_

  - [x] 8.4 實作 `RoutePanel` 元件
    - 在 `frontend/src/components/RoutePanel.tsx` 實作路徑點清單、速度選擇器（步行 / 跑步 / 騎車 / 自訂）、啟動 / 暫停 / 繼續 / 停止按鈕、循環模式開關
    - 路徑點少於 2 個時停用啟動按鈕並顯示提示訊息
    - 使用 `useRoute` Hook
    - _需求：3.2、3.6、3.7、3.8、3.9、3.10_

  - [x] 8.5 組裝主應用程式
    - 在 `frontend/src/App.tsx` 整合所有元件：`DeviceStatus`、`MapInterface`、`JoystickController`、`RoutePanel`
    - 實作 API 呼叫失敗時的 toast 通知
    - 實作裝置斷線時的警告橫幅
    - _需求：1.3、2.3、2.5_

  - [ ]* 8.6 撰寫搖桿 GPS 偏移屬性測試（前端）
    - 在 `frontend/src/` 使用 fast-check 撰寫屬性測試
    - **屬性 3：搖桿移動向量計算正確性（偏移距離誤差 < 1m）**
    - **驗證：需求 4.2**

  - [ ]* 8.7 撰寫前端元件單元測試
    - 使用 Vitest + React Testing Library 測試 `MapInterface` 點選事件、`JoystickController` throttle 行為、`RoutePanel` 按鈕狀態
    - _需求：2.2、3.9、4.3、4.4_

- [x] 9. 前端檢查點
  - 確認所有前端測試通過，如有問題請提出。

- [x] 10. Docker 設定
  - [x] 10.1 建立後端 Dockerfile
    - 在 `backend/Dockerfile` 使用 `python:3.11-slim` 基礎映像
    - 安裝 `requirements.txt` 依賴，以 uvicorn 啟動 FastAPI
    - 暴露 port 8000
    - _需求：6.1、6.5_

  - [x] 10.2 建立前端 Dockerfile
    - 在 `frontend/Dockerfile` 使用多階段建置（node 建置 + nginx 服務靜態檔案）
    - 暴露 port 3000
    - _需求：6.1、6.4_

  - [x] 10.3 建立 `docker-compose.yml`
    - 定義 `backend` 服務：掛載 `/dev/bus/usb`、設定 `MOCK_MODE` 環境變數、port 8000
    - 定義 `frontend` 服務：設定 `VITE_GOOGLE_MAPS_API_KEY`、`VITE_API_URL`、port 3000
    - 設定服務依賴（frontend depends_on backend）
    - _需求：6.1、6.2、6.3、6.4、6.5、6.6、6.7_

- [x] 11. 最終檢查點
  - 確認所有測試通過，Docker Compose 設定格式正確，如有問題請提出。

---

## 備註

- 標記 `*` 的子任務為選填，可跳過以加速 MVP 開發
- 每個任務均對應具體需求條款，確保可追溯性
- 屬性測試（Hypothesis / fast-check）驗證核心計算邏輯的普遍正確性
- 單元測試驗證具體範例與邊界條件
- 檢查點確保漸進式驗證，避免問題累積
