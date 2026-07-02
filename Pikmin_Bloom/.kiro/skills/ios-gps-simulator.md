# iOS GPS 模擬器 — Steering 文件

## 專案概述

本專案是一個類似 iAnyGo 的網頁版 iOS GPS 模擬工具。
使用者透過瀏覽器操作地圖、路徑規劃或搖桿，後端透過 pymobiledevice3 控制 iPhone 的模擬 GPS 位置。
整體服務以 Docker Compose 部署。

---

## 技術棧

| 層級 | 技術選擇 |
|------|----------|
| 前端框架 | React (TypeScript) |
| 地圖元件 | Leaflet.js（預設）/ Google Maps（可選） |
| 後端框架 | FastAPI (Python 3.11+) |
| iOS 裝置控制 | pymobiledevice3 |
| 部署 | Docker + Docker Compose |
| 前後端通訊 | REST API + WebSocket（即時狀態推送） |

---

## 專案結構

```
ios-gps-simulator/
├── frontend/
│   ├── src/
│   │   ├── components/
│   │   │   ├── MapInterface.tsx      # 地圖點選與路徑規劃
│   │   │   ├── JoystickController.tsx # 搖桿控制元件
│   │   │   ├── RoutePanel.tsx        # 路徑管理面板
│   │   │   └── DeviceStatus.tsx      # 裝置連線狀態
│   │   ├── hooks/
│   │   │   ├── useDevice.ts          # 裝置狀態管理
│   │   │   └── useRoute.ts           # 路徑狀態管理
│   │   └── api/
│   │       └── client.ts             # API 呼叫封裝
│   ├── Dockerfile
│   └── package.json
├── backend/
│   ├── app/
│   │   ├── main.py                   # FastAPI 入口
│   │   ├── routers/
│   │   │   ├── devices.py            # 裝置管理 API
│   │   │   ├── location.py           # GPS 座標設定 API
│   │   │   └── route.py              # 路徑控制 API
│   │   ├── services/
│   │   │   ├── device_manager.py     # pymobiledevice3 封裝
│   │   │   └── route_engine.py       # 路徑自動移動邏輯
│   │   └── models/
│   │       └── schemas.py            # Pydantic 資料模型
│   ├── Dockerfile
│   └── requirements.txt
└── docker-compose.yml
```

---

## 核心架構原則

### 後端設計
- 使用 FastAPI 的 `asyncio` 處理路徑自動移動，避免阻塞主執行緒
- `DeviceManager` 封裝所有 pymobiledevice3 呼叫，對外提供統一介面
- 若 USB 裝置不可用，`DeviceManager` 以 mock mode 啟動，記錄 warning 但不拋出例外
- 路徑移動狀態（idle / moving / paused）儲存於記憶體，透過 WebSocket 推送給前端

### 前端設計
- 地圖預設使用 Leaflet.js + OpenStreetMap，無需 API Key
- 若環境變數 `VITE_GOOGLE_MAPS_API_KEY` 存在，切換為 Google Maps
- 搖桿元件每 200ms 發送一次座標更新（throttle）
- 路徑自動移動與搖桿控制互斥，搖桿優先

### API 設計規範
- 所有 API 路徑前綴為 `/api`
- 回應格式統一為 JSON
- 錯誤回應格式：`{"error": "描述", "code": "ERROR_CODE"}`
- GPS 座標驗證：緯度 -90~90，經度 -180~180

---

## API 端點摘要

| 方法 | 路徑 | 說明 |
|------|------|------|
| GET | `/api/devices` | 取得連線裝置清單 |
| POST | `/api/location` | 設定 GPS 座標 |
| POST | `/api/route/start` | 啟動路徑自動移動 |
| POST | `/api/route/pause` | 暫停路徑移動 |
| POST | `/api/route/stop` | 停止路徑移動 |
| GET | `/api/status` | 取得目前模擬狀態 |
| WS | `/ws/status` | WebSocket 即時狀態推送 |

---

## 資料模型

```python
# GPS 座標
class GPSCoordinate(BaseModel):
    latitude: float   # -90 ~ 90
    longitude: float  # -180 ~ 180

# 設定位置請求
class SetLocationRequest(BaseModel):
    latitude: float
    longitude: float
    device_id: str

# 路徑請求
class RouteRequest(BaseModel):
    waypoints: list[GPSCoordinate]  # 至少 2 個點
    speed: float                     # m/s，1.0 ~ 10.0
    loop: bool = False               # 是否循環

# 速度預設值
SPEED_PROFILES = {
    "walking": 1.4,   # m/s
    "running": 3.0,
    "cycling": 5.0,
}
```

---

## Docker Compose 設定重點

```yaml
services:
  backend:
    ports: ["8000:8000"]
    devices:
      - "/dev/bus/usb:/dev/bus/usb"  # USB 裝置存取
    environment:
      - MOCK_MODE=false

  frontend:
    ports: ["3000:3000"]
    environment:
      - VITE_GOOGLE_MAPS_API_KEY=${GOOGLE_MAPS_API_KEY:-}
      - VITE_API_URL=http://localhost:8000
```

---

## 開發注意事項

1. pymobiledevice3 需要主機有 usbmuxd 服務，Docker 容器需掛載 USB 裝置
2. iOS 裝置需信任連接的電腦（首次連線需在手機點選「信任」）
3. 路徑移動的座標插值使用 Haversine 公式計算兩點間距離
4. 搖桿移動方向以正北為 0 度，順時針計算方位角，再轉換為 GPS 偏移量
5. 前端開發時可設定 `MOCK_MODE=true` 讓後端回傳假資料，無需實體裝置

---

## 測試策略

- 後端單元測試：使用 pytest，DeviceManager 以 mock 替代真實裝置
- 路徑引擎測試：驗證座標插值計算的正確性（Haversine 距離誤差 < 1m）
- 前端元件測試：使用 Vitest + React Testing Library
- 整合測試：使用 mock mode 驗證前後端 API 串接
