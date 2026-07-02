import { useState } from 'react'
import type { GPSCoordinate, RouteStatus } from '../types'

type FlowerRouteVariant = 'fast' | 'best'

interface GeneratedRouteSummary {
  variant: FlowerRouteVariant
  totalDistanceMeters: number
}

interface RoutePanelProps {
  waypoints: GPSCoordinate[]
  routeStatus: RouteStatus
  hasGeneratedFlowerRoute: boolean
  generatedRouteSummary: GeneratedRouteSummary | null
  onGenerateFlowerRoute: (variant: FlowerRouteVariant) => void
  onStartRoute: (speed: number, loop: boolean) => Promise<void>
  onPauseRoute: () => Promise<void>
  onResumeRoute: () => Promise<void>
  onStopRoute: () => Promise<void>
}

const JOG_SPEED = 20 / 3.6
const FLOWER_ROUTE_LABEL: Record<FlowerRouteVariant, string> = {
  fast: '快速綠線',
  best: '最佳路線',
}

function formatRouteDistance(meters: number): string {
  if (meters >= 1000) return `${(meters / 1000).toFixed(2)} km`
  return `${Math.round(meters)} m`
}

export function RoutePanel({
  waypoints,
  routeStatus,
  hasGeneratedFlowerRoute,
  generatedRouteSummary,
  onGenerateFlowerRoute,
  onStartRoute,
  onPauseRoute,
  onResumeRoute,
  onStopRoute,
}: RoutePanelProps) {
  const [loop, setLoop] = useState(false)
  const [loading, setLoading] = useState(false)

  const canStart = waypoints.length >= 2
  const canGenerateFlowerRoute = waypoints.length >= 3
  const isMoving = routeStatus.state === 'moving'
  const isPaused = routeStatus.state === 'paused'
  const isRunning = isMoving || isPaused
  const locked = isRunning || loading
  const shouldLoop = loop || hasGeneratedFlowerRoute

  async function withLoading(action: () => Promise<void>) {
    setLoading(true)
    try {
      await action()
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="route-panel">
      <div className="route-generator-block">
        <div className="route-generator-actions">
          <button
            className="secondary-button route-generator-button"
            onClick={() => onGenerateFlowerRoute('best')}
            disabled={!canGenerateFlowerRoute || locked}
            type="button"
          >
            最佳路線
          </button>
        </div>
        {generatedRouteSummary && (
          <div className="route-distance-result" aria-live="polite">
            <span>{FLOWER_ROUTE_LABEL[generatedRouteSummary.variant]}</span>
            <strong>循環總距離 {formatRouteDistance(generatedRouteSummary.totalDistanceMeters)}</strong>
          </div>
        )}
        <p className="helper-text" aria-live="polite">
          {hasGeneratedFlowerRoute
            ? '已依最佳循環順序重新編號，開始種花會自動循環'
            : canGenerateFlowerRoute
            ? '依最佳路線重新排列路徑點'
            : '至少需要 3 個花點才能產生循環路線'}
        </p>
      </div>

      {!hasGeneratedFlowerRoute && (
        <label className="toggle-row">
          <input
            type="checkbox"
            checked={loop}
            onChange={(e) => setLoop(e.target.checked)}
            disabled={locked}
          />
          <span>循環路線</span>
        </label>
      )}

      {isRunning && (
        <div className="progress-block">
          <div className="progress-label">
            <span>{isPaused ? '路線已暫停' : '路線移動中'}</span>
            <strong>{Math.round(routeStatus.progress * 100)}%</strong>
          </div>
          <div className="progress-bar">
            <div style={{ transform: `scaleX(${routeStatus.progress})` }} />
          </div>
        </div>
      )}

      <div className="route-actions">
        {!isRunning ? (
          <button
            className="primary-button route-start-button"
            onClick={() => void withLoading(() => onStartRoute(JOG_SPEED, shouldLoop))}
            disabled={!canStart || loading}
          >
            {loading ? '啟動中' : '開始種花（20 km/h）'}
          </button>
        ) : (
          <>
            {isMoving ? (
              <button className="secondary-button" onClick={() => void withLoading(onPauseRoute)} disabled={loading}>
                暫停
              </button>
            ) : (
              <button className="secondary-button" onClick={() => void withLoading(onResumeRoute)} disabled={loading}>
                繼續
              </button>
            )}
            <button className="accent-button" onClick={() => void withLoading(onStopRoute)} disabled={loading}>
              停止
            </button>
          </>
        )}
      </div>
    </div>
  )
}
