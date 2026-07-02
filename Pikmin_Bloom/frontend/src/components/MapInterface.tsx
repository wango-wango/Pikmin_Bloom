import { Copy, LocateFixed, MapPinPlus } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import type { GPSCoordinate, PostcardLandmark, SavedLandmark } from '../types'

delete (L.Icon.Default.prototype as unknown as Record<string, unknown>)._getIconUrl
L.Icon.Default.mergeOptions({
  iconRetinaUrl: '/marker-icon-2x.png',
  iconUrl: '/marker-icon.png',
  shadowUrl: '/marker-shadow.png',
})

const TILE_STYLES = [
  {
    id: 'osm',
    label: 'OSM',
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  },
  {
    id: 'positron',
    label: '簡潔',
    url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors © <a href="https://carto.com/attributions">CARTO</a>',
  },
  {
    id: 'dark',
    label: '深色',
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors © <a href="https://carto.com/attributions">CARTO</a>',
  },
] as const

type TileStyleId = (typeof TILE_STYLES)[number]['id']

const MAP_COLORS = {
  currentStroke: '#ff385c',
  currentFill: '#ff8aa0',
  routeStroke: '#ff385c',
  routeStartBg: '#32d74b',
  routeStartBorder: '#0b6f25',
  routeStartText: '#0f2515',
  routePointBg: '#ffffff',
  routePointBorder: '#ff9f0a',
  routePointText: '#3a2500',
  flowerBg: '#ffffff',
  flowerBorder: '#c2185b',
  flowerFill: '#ff2d55',
  mushroomBg: '#ffffff',
  mushroomBorder: '#7a4b1f',
  mushroomFill: '#a15c21',
} as const

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function landmarkTypeLabel(type: SavedLandmark['landmarkType']): string {
  return type === 'flower' ? '花點' : '菇點'
}

interface MapInterfaceProps {
  mode: 'single' | 'route'
  currentPosition: GPSCoordinate | null
  viewTarget: GPSCoordinate | null
  waypoints: GPSCoordinate[]
  savedLandmarks: SavedLandmark[]
  postcardLandmarks?: PostcardLandmark[]
  showPostcards?: boolean
  focusedPostcardId?: string
  postcardFocusTarget?: GPSCoordinate | null
  onViewportChange?: (bounds: { north: number; south: number; east: number; west: number }) => void
  onPostcardAddLandmark?: (postcard: PostcardLandmark) => void
  onPostcardAction?: (message: string) => void
  onMapClick: (coord: GPSCoordinate) => void
  onWaypointMove?: (index: number, coord: GPSCoordinate) => void
  onWaypointRemove?: (index: number) => void
  onWaypointCopyCoordinate?: (index: number) => void
  onWaypointSetAsStart?: (index: number) => void
  onWaypointSetAsEnd?: (index: number) => void
  canEditWaypoints?: boolean
  showGeneratedFlowerRoute?: boolean
}

interface WaypointContextMenu {
  index: number
  x: number
  y: number
}

interface PostcardContextMenu {
  postcard: PostcardLandmark
  x: number
  y: number
}

export default function MapInterface({
  mode,
  currentPosition,
  viewTarget,
  waypoints,
  savedLandmarks,
  postcardLandmarks = [],
  showPostcards = false,
  focusedPostcardId = '',
  postcardFocusTarget = null,
  onViewportChange,
  onPostcardAddLandmark,
  onPostcardAction,
  onMapClick,
  onWaypointMove,
  onWaypointRemove,
  onWaypointCopyCoordinate,
  onWaypointSetAsStart,
  onWaypointSetAsEnd,
  canEditWaypoints = false,
  showGeneratedFlowerRoute = false,
}: MapInterfaceProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<L.Map | null>(null)
  const tileLayerRef = useRef<L.TileLayer | null>(null)
  const currentMarkerRef = useRef<L.CircleMarker | null>(null)
  const waypointMarkersRef = useRef<L.Marker[]>([])
  const landmarkMarkersRef = useRef<L.Marker[]>([])
  const postcardMarkersRef = useRef<L.Marker[]>([])
  const polylineRef = useRef<L.Polyline | null>(null)
  const prevPositionRef = useRef<GPSCoordinate | null>(null)
  const isDraggingWaypointRef = useRef(false)
  const [styleId, setStyleId] = useState<TileStyleId>('positron')
  const [waypointMenu, setWaypointMenu] = useState<WaypointContextMenu | null>(null)
  const [postcardMenu, setPostcardMenu] = useState<PostcardContextMenu | null>(null)

  const emitViewport = (map: L.Map) => {
    const bounds = map.getBounds()
    onViewportChange?.({
      north: bounds.getNorth(),
      south: bounds.getSouth(),
      east: bounds.getEast(),
      west: bounds.getWest(),
    })
  }

  // 初始化地圖
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return

    const map = L.map(containerRef.current, {
      doubleClickZoom: false,
    }).setView([23.5, 121.0], 8)

    const style = TILE_STYLES.find((s) => s.id === styleId) ?? TILE_STYLES[0]
    tileLayerRef.current = L.tileLayer(style.url, { attribution: style.attribution }).addTo(map)

    map.on('click', (e: L.LeafletMouseEvent) => {
      onMapClick({ latitude: e.latlng.lat, longitude: e.latlng.lng })
    })
    map.on('moveend zoomend', () => emitViewport(map))

    mapRef.current = map
    emitViewport(map)

    return () => {
      map.remove()
      mapRef.current = null
      tileLayerRef.current = null
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const map = mapRef.current
    if (!map || !onViewportChange) return
    emitViewport(map)
  }, [onViewportChange])

  // 切換 tile 樣式
  useEffect(() => {
    const map = mapRef.current
    if (!map) return

    const style = TILE_STYLES.find((s) => s.id === styleId)
    if (!style) return

    if (tileLayerRef.current) {
      map.removeLayer(tileLayerRef.current)
    }
    tileLayerRef.current = L.tileLayer(style.url, { attribution: style.attribution }).addTo(map)
  }, [styleId])

  // 更新 click handler（避免 stale closure）
  useEffect(() => {
    const map = mapRef.current
    if (!map) return

    const handler = (e: L.LeafletMouseEvent) => {
      if (isDraggingWaypointRef.current) return
      setWaypointMenu(null)
      setPostcardMenu(null)
      onMapClick({ latitude: e.latlng.lat, longitude: e.latlng.lng })
    }

    map.off('click')
    map.on('click', handler)
  }, [onMapClick])

  // 更新目前位置標記
  useEffect(() => {
    const map = mapRef.current
    if (!map) return

    if (currentMarkerRef.current) {
      currentMarkerRef.current.remove()
      currentMarkerRef.current = null
    }

    if (currentPosition) {
      currentMarkerRef.current = L.circleMarker(
        [currentPosition.latitude, currentPosition.longitude],
        {
          radius: 10,
          color: MAP_COLORS.currentStroke,
          fillColor: MAP_COLORS.currentFill,
          fillOpacity: 0.95,
          weight: 3,
        }
      ).addTo(map)

      if (!prevPositionRef.current) {
        map.setView([currentPosition.latitude, currentPosition.longitude], 16, { animate: true })
      }
      prevPositionRef.current = currentPosition
    } else {
      prevPositionRef.current = null
    }
  }, [currentPosition])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !viewTarget) return

    map.setView([viewTarget.latitude, viewTarget.longitude], 16, { animate: true })
  }, [viewTarget])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !postcardFocusTarget) return

    map.setView([postcardFocusTarget.latitude, postcardFocusTarget.longitude], Math.max(map.getZoom(), 17), { animate: true })
  }, [postcardFocusTarget])

  // 更新路徑點標記與連線
  useEffect(() => {
    const map = mapRef.current
    if (!map) return

    waypointMarkersRef.current.forEach((m) => m.remove())
    waypointMarkersRef.current = []

    if (polylineRef.current) {
      polylineRef.current.remove()
      polylineRef.current = null
    }

    waypoints.forEach((wp, index) => {
      const isStart = index === 0
      const icon = L.divIcon({
        className: '',
        html: `<div class="${isStart ? 'route-start-map-marker' : 'route-map-marker'}" title="${isStart ? '路徑起點' : `路徑點 ${index + 1}`}" style="
          background: ${isStart ? MAP_COLORS.routeStartBg : MAP_COLORS.routePointBg};
          color: ${isStart ? MAP_COLORS.routeStartText : MAP_COLORS.routePointText};
          border-radius: 50%;
          width: ${isStart ? 32 : 28}px;
          height: ${isStart ? 32 : 28}px;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 13px;
          font-weight: 800;
          border: ${isStart ? 3 : 2}px solid ${isStart ? MAP_COLORS.routeStartBorder : MAP_COLORS.routePointBorder};
          box-shadow: ${isStart ? '0 0 0 5px rgba(50, 215, 75, 0.30), 0 7px 18px rgba(15,37,21,0.30)' : '0 3px 10px rgba(58,37,0,0.24)'};
        ">${isStart ? '起' : index + 1}</div>`,
        iconSize: isStart ? [32, 32] : [28, 28],
        iconAnchor: isStart ? [16, 16] : [14, 14],
      })

      const marker = L.marker([wp.latitude, wp.longitude], { icon }).addTo(map)
      if (canEditWaypoints && onWaypointMove) {
        marker.dragging?.enable()
        marker.on('dragstart', () => {
          setWaypointMenu(null)
          setPostcardMenu(null)
          isDraggingWaypointRef.current = true
        })
        marker.on('dragend', () => {
          const next = marker.getLatLng()
          onWaypointMove(index, { latitude: next.lat, longitude: next.lng })
          window.setTimeout(() => {
            isDraggingWaypointRef.current = false
          }, 0)
        })
      }
      if (canEditWaypoints) {
        marker.on('contextmenu', (event: L.LeafletMouseEvent) => {
          const originalEvent = event.originalEvent
          originalEvent.preventDefault()
          originalEvent.stopPropagation()
          const bounds = containerRef.current?.getBoundingClientRect()
          const x = bounds ? originalEvent.clientX - bounds.left : event.containerPoint.x
          const y = bounds ? originalEvent.clientY - bounds.top : event.containerPoint.y
          setWaypointMenu({ index, x, y })
        })
      }
      waypointMarkersRef.current.push(marker)
    })

    if (mode === 'route' && showGeneratedFlowerRoute && waypoints.length >= 3) {
      const latlngs = [
        ...waypoints.map((wp) => [wp.latitude, wp.longitude] as L.LatLngTuple),
        [waypoints[0].latitude, waypoints[0].longitude] as L.LatLngTuple,
      ]
      polylineRef.current = L.polyline(latlngs, {
        color: MAP_COLORS.routeStroke,
        weight: 5,
        opacity: 0.86,
      }).addTo(map)
    }
  }, [waypoints, mode, canEditWaypoints, onWaypointMove, showGeneratedFlowerRoute])

  useEffect(() => {
    setWaypointMenu(null)
  }, [waypoints.length, canEditWaypoints])

  useEffect(() => {
    if (!waypointMenu && !postcardMenu) return

    const closeMenu = () => {
      setWaypointMenu(null)
      setPostcardMenu(null)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeMenu()
    }

    window.addEventListener('click', closeMenu)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('click', closeMenu)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [postcardMenu, waypointMenu])

  const selectedWaypoint = waypointMenu ? waypoints[waypointMenu.index] : null

  useEffect(() => {
    const map = mapRef.current
    if (!map) return

    landmarkMarkersRef.current.forEach((m) => m.remove())
    landmarkMarkersRef.current = []

    savedLandmarks.forEach((landmark) => {
      const isFlower = landmark.landmarkType === 'flower'
      const label = landmarkTypeLabel(landmark.landmarkType)
      const icon = L.divIcon({
        className: '',
        html: `<div class="${isFlower ? 'landmark-map-marker is-flower' : 'landmark-map-marker is-mushroom'}" title="${escapeHtml(`${label}：${landmark.name}`)}" style="
          position: relative;
          width: 24px;
          height: 24px;
          border-radius: ${isFlower ? '50%' : '8px 8px 12px 12px'};
          background: ${isFlower ? MAP_COLORS.flowerBg : MAP_COLORS.mushroomBg};
          border: 3px solid ${isFlower ? MAP_COLORS.flowerBorder : MAP_COLORS.mushroomBorder};
          box-shadow: 0 0 0 2px rgba(255,255,255,0.96), 0 7px 18px rgba(18, 18, 20, 0.28);
        ">
          <span style="
            position: absolute;
            inset: 5px;
            border-radius: inherit;
            background: ${isFlower ? MAP_COLORS.flowerFill : MAP_COLORS.mushroomFill};
          "></span>
        </div>`,
        iconSize: [24, 24],
        iconAnchor: [12, 12],
        popupAnchor: [0, -12],
      })
      const marker = L.marker([landmark.coordinate.latitude, landmark.coordinate.longitude], { icon }).addTo(map)
      marker.bindPopup(
        `<strong>${escapeHtml(landmark.name)}</strong><br/><span>${label}</span><br/>${landmark.coordinate.latitude.toFixed(6)}, ${landmark.coordinate.longitude.toFixed(6)}`
      )
      landmarkMarkersRef.current.push(marker)
    })
  }, [savedLandmarks])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return

    postcardMarkersRef.current.forEach((m) => m.remove())
    postcardMarkersRef.current = []

    if (!showPostcards) return

    postcardLandmarks.forEach((postcard) => {
      const imageUrl = escapeHtml(postcard.imageUrl)
      const name = escapeHtml(postcard.name)
      const isFocused = focusedPostcardId === postcard.id
      const icon = L.divIcon({
        className: '',
        html: `<div class="postcard-map-point${isFocused ? ' is-focused' : ''}" title="${name}">
          <span></span>
        </div>`,
        iconSize: [24, 24],
        iconAnchor: [12, 12],
        popupAnchor: [0, -14],
      })
      const marker = L.marker(
        [postcard.coordinate.latitude, postcard.coordinate.longitude],
        { icon },
      ).addTo(map)
      marker.bindPopup(
        `<div class="postcard-popup">
          <img src="${imageUrl}" alt="" referrerpolicy="no-referrer" />
          <strong>${name}</strong>
          <span>${postcard.coordinate.latitude.toFixed(6)}, ${postcard.coordinate.longitude.toFixed(6)}</span>
        </div>`,
      )
      if (onPostcardAddLandmark) {
        marker.on('contextmenu', (event: L.LeafletMouseEvent) => {
          const originalEvent = event.originalEvent
          originalEvent.preventDefault()
          originalEvent.stopPropagation()
          const bounds = containerRef.current?.getBoundingClientRect()
          const x = bounds ? originalEvent.clientX - bounds.left : event.containerPoint.x
          const y = bounds ? originalEvent.clientY - bounds.top : event.containerPoint.y
          setWaypointMenu(null)
          setPostcardMenu({ postcard, x, y })
        })
      }
      postcardMarkersRef.current.push(marker)
    })
  }, [focusedPostcardId, onPostcardAddLandmark, postcardLandmarks, showPostcards])

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
      {waypointMenu && selectedWaypoint && (
        <div
          className="waypoint-context-menu"
          style={{ left: waypointMenu.x, top: waypointMenu.y }}
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
        >
          <button
            type="button"
            onClick={() => {
              onWaypointCopyCoordinate?.(waypointMenu.index)
              setWaypointMenu(null)
            }}
          >
            複製座標
          </button>
          <button
            type="button"
            onClick={() => {
              onWaypointSetAsStart?.(waypointMenu.index)
              setWaypointMenu(null)
            }}
            disabled={waypointMenu.index === 0}
          >
            設為起點
          </button>
          <button
            type="button"
            onClick={() => {
              onWaypointSetAsEnd?.(waypointMenu.index)
              setWaypointMenu(null)
            }}
            disabled={waypointMenu.index === waypoints.length - 1}
          >
            設為終點
          </button>
          <button
            type="button"
            className="is-danger"
            onClick={() => {
              onWaypointRemove?.(waypointMenu.index)
              setWaypointMenu(null)
            }}
          >
            移除節點
          </button>
        </div>
      )}
      {postcardMenu && (
        <div
          className="waypoint-context-menu postcard-context-menu"
          style={{ left: postcardMenu.x, top: postcardMenu.y }}
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
        >
          <div className="postcard-menu-header">
            <strong>{postcardMenu.postcard.name}</strong>
            <div className="postcard-menu-actions">
              <button
                type="button"
                className="postcard-icon-action"
                onClick={() => {
                  const coord = postcardMenu.postcard.coordinate
                  const text = `${postcardMenu.postcard.name}\n${coord.latitude.toFixed(6)}, ${coord.longitude.toFixed(6)}`
                  void navigator.clipboard?.writeText(text).then(() => {
                    onPostcardAction?.('已複製明信片資訊')
                  })
                }}
                aria-label="複製明信片名稱與座標"
                title="複製名稱與座標"
              >
                <Copy aria-hidden="true" size={16} strokeWidth={2.4} />
              </button>
              <button
                type="button"
                className="postcard-icon-action"
                onClick={() => {
                  onPostcardAddLandmark?.(postcardMenu.postcard)
                  setPostcardMenu(null)
                }}
                aria-label="加入地標"
                title="加入地標"
              >
                <MapPinPlus aria-hidden="true" size={17} strokeWidth={2.4} />
              </button>
            </div>
          </div>
          <div className="postcard-coordinate-info">
            <span>{postcardMenu.postcard.coordinate.latitude.toFixed(6)}</span>
            <span>{postcardMenu.postcard.coordinate.longitude.toFixed(6)}</span>
          </div>
        </div>
      )}
      <div className="map-controls-overlay">
        <button
          type="button"
          className="map-locate-btn"
          onClick={() => {
            if (currentPosition && mapRef.current) {
              mapRef.current.setView([currentPosition.latitude, currentPosition.longitude], 16, { animate: true })
            }
          }}
          title="回到目前虛擬位置"
          aria-label="回到目前位置"
        >
          <LocateFixed size={20} strokeWidth={2.4} />
        </button>
        <div className="map-style-switcher">
          {TILE_STYLES.map((s) => (
            <button
              key={s.id}
              className={`map-style-btn${styleId === s.id ? ' is-active' : ''}`}
              onClick={() => setStyleId(s.id)}
              aria-pressed={styleId === s.id}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
