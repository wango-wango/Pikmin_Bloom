# iOS GPS 模擬器 — 啟動指令（固定）

## 固定啟動方式

```bash
cd /Users/ggt/Documents/GitHub/susi/pikomin
./scripts/docker-stack.sh restart
```

這是唯一建議的日常啟動方式，會先啟動 host bridge，再重啟 backend/frontend，避免「定位橋接失敗」。

開啟瀏覽器：`http://localhost:5678`

## 狀態與日誌

```bash
./scripts/docker-stack.sh status
./scripts/docker-stack.sh logs
```

## 停止

```bash
./scripts/docker-stack.sh down
```

## 常用 API 測試

```bash
curl -s http://localhost:5679/api/status
curl -s http://localhost:5679/api/devices
curl -s http://localhost:5679/api/tunnel/status
```
