import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Church, Copy, Download, FileInput, FolderOpen, Layers3, Loader2, Lock, Mail, Map, MoreHorizontal, MousePointerClick, Pencil, Radar, Save, Search, Trees, Trash2, X, Zap } from 'lucide-react'
import './app.css'
import { apiClient } from './api/client'
import { DeviceStatus } from './components/DeviceStatus'
import { LocationSearch } from './components/LocationSearch'
import MapInterface from './components/MapInterface'
import { RoutePanel } from './components/RoutePanel'
import { useDevice } from './hooks/useDevice'
import { useRoute } from './hooks/useRoute'
import {
  calculateCycleDistanceMeters,
  optimizeFlowerRoute,
  optimizeFlowerRouteDeepSearch,
} from './utils/routeOptimizer'
import type { GPSCoordinate, PostcardLandmark, SavedLandmark, SavedRoute } from './types'

type Mode = 'single' | 'route'
type FlyMode = 'coordinate' | 'landmark'
type ManagerTab = 'landmarks' | 'routes'
type LandmarkManagerTab = 'create' | 'search'
type PostcardFilterType = 'temple' | 'transformer' | 'church' | 'park'
type RouteImportMode = 'json' | 'coordinates'
type FlowerRouteVariant = 'fast' | 'best'
const LANDMARKS_PER_PAGE = 5
const ROUTES_PER_PAGE = 5
const ROUTE_TOOLBAR_ICON_PROPS = { size: 22, strokeWidth: 2.4 }

interface Toast {
  id: number
  message: string
}

interface RouteFilePayload {
  name?: unknown
  waypoints?: unknown
}

interface GeneratedRouteSummary {
  variant: FlowerRouteVariant
  totalDistanceMeters: number
}

interface LandmarkFilePayload {
  version?: unknown
  name?: unknown
  exportedAt?: unknown
  coordinate?: unknown
  landmarkType?: unknown
}

interface MapBounds {
  north: number
  south: number
  east: number
  west: number
}

const POSTCARD_FILTERS: { id: PostcardFilterType; label: string; keywords: string[] }[] = [
  { id: 'temple', label: '廟宇', keywords: ['廟', '宮', '寺', '佛教', '蓮社', '精舍', '聖母', 'temple', 'shrine'] },
  { id: 'transformer', label: '變電箱', keywords: ['變電箱', '配電箱', '電箱', '電氣箱', '光纖電箱', 'transformer'] },
  { id: 'church', label: '教堂', keywords: ['教堂', '教會', '基督', '召會', 'church', 'cathedral', 'chapel'] },
  { id: 'park', label: '公園', keywords: ['公園', '涼亭', '遊戲區', 'park', 'pavilion'] },
]

const INITIAL_POSTCARD_FILTERS: Record<PostcardFilterType, boolean> = {
  temple: true,
  transformer: true,
  church: true,
  park: true,
}

function TempleIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M12 2.5 4 7v2h16V7l-8-4.5Zm-7.5 8A4.4 4.4 0 0 0 8 12.2h8a4.4 4.4 0 0 0 3.5-1.7H21v2H3v-2h1.5ZM5 14h3v5H5v-5Zm5 0h4v5h-1.2v-2.2a.8.8 0 0 0-1.6 0V19H10v-5Zm6 0h3v5h-3v-5ZM3 20h18v2H3v-2Z"
      />
    </svg>
  )
}

function postcardFilterIcon(filterId: PostcardFilterType) {
  if (filterId === 'temple') return <TempleIcon />
  if (filterId === 'transformer') return <Zap aria-hidden="true" size={18} strokeWidth={2.5} />
  if (filterId === 'church') return <Church aria-hidden="true" size={18} strokeWidth={2.4} />
  return <Trees aria-hidden="true" size={18} strokeWidth={2.4} />
}

let toastIdCounter = 0

function parseCoordinateInput(value: string): GPSCoordinate | null {
  const normalized = value
    .replace(/，/g, ',')
    .trim()
    .replace(/\s+/g, ' ')

  const byComma = normalized.split(',').map((segment) => segment.trim()).filter(Boolean)
  const partsText = byComma.length === 2 ? byComma : normalized.split(' ').map((segment) => segment.trim()).filter(Boolean)
  const parts = partsText.map((segment) => Number.parseFloat(segment))
  if (parts.length !== 2 || parts.some((part) => Number.isNaN(part))) {
    return null
  }

  return { latitude: parts[0], longitude: parts[1] }
}

function formatCoordinate(coord: GPSCoordinate | null): string {
  if (!coord) return '尚未設定'
  return `${coord.latitude.toFixed(6)}, ${coord.longitude.toFixed(6)}`
}

function formatRouteDistance(points: GPSCoordinate[]): string {
  const meters = calculateCycleDistanceMeters(points)
  if (meters < 1000) return `${Math.round(meters)} m`
  return `${(meters / 1000).toFixed(1)} km`
}

function distanceMeters(a: GPSCoordinate, b: GPSCoordinate): number {
  const earthRadius = 6371000
  const toRadians = (value: number) => (value * Math.PI) / 180
  const dLat = toRadians(b.latitude - a.latitude)
  const dLng = toRadians(b.longitude - a.longitude)
  const lat1 = toRadians(a.latitude)
  const lat2 = toRadians(b.latitude)
  const h = (
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  )
  return earthRadius * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h))
}

function boundsCenter(bounds: MapBounds): GPSCoordinate {
  return {
    latitude: (bounds.north + bounds.south) / 2,
    longitude: (bounds.east + bounds.west) / 2,
  }
}

function boundsRadiusMeters(bounds: MapBounds): number {
  const center = boundsCenter(bounds)
  const corner = { latitude: bounds.north, longitude: bounds.east }
  return Math.min(Math.max(distanceMeters(center, corner), 500), 120000)
}

function postcardLimitForRadius(radiusM: number): number {
  if (radiusM < 1500) return 80
  if (radiusM < 4000) return 160
  if (radiusM < 10000) return 260
  return 300
}

function formatPostcardFilterLabel(filters: Record<PostcardFilterType, boolean>): string {
  const enabled = POSTCARD_FILTERS.filter((filter) => filters[filter.id])
  if (enabled.length === POSTCARD_FILTERS.length) return '明信片'
  if (enabled.length === 1) return enabled[0].label
  if (enabled.length === 0) return '明信片'
  return enabled.map((filter) => filter.label).join('、')
}

function filterPostcardsInBounds(
  items: PostcardLandmark[],
  bounds: MapBounds,
  filters: Record<PostcardFilterType, boolean>,
): PostcardLandmark[] {
  const allEnabled = POSTCARD_FILTERS.every((filter) => filters[filter.id])
  return items.filter((postcard) => {
    const type = getPostcardFilterType(postcard)
    const typeMatched = allEnabled ? true : type !== null && filters[type]
    return (
      typeMatched &&
      postcard.coordinate.latitude <= bounds.north &&
      postcard.coordinate.latitude >= bounds.south &&
      postcard.coordinate.longitude <= bounds.east &&
      postcard.coordinate.longitude >= bounds.west
    )
  })
}

function mergePostcardSources(primary: PostcardLandmark[], secondary: PostcardLandmark[]): PostcardLandmark[] {
  const merged = [...primary]
  const seenIds = new Set(primary.map((postcard) => postcard.id))
  for (const postcard of secondary) {
    if (seenIds.has(postcard.id)) continue
    const duplicate = merged.some((item) => (
      distanceMeters(item.coordinate, postcard.coordinate) <= 20 ||
      (
        item.name.trim().toLowerCase() === postcard.name.trim().toLowerCase() &&
        distanceMeters(item.coordinate, postcard.coordinate) <= 80
      )
    ))
    if (duplicate) continue
    seenIds.add(postcard.id)
    merged.push(postcard)
  }
  return merged
}

function getPostcardFilterType(postcard: PostcardLandmark): PostcardFilterType | null {
  const haystack = `${postcard.name} ${postcard.tags.join(' ')}`.toLowerCase()
  return POSTCARD_FILTERS.find((filter) => (
    filter.keywords.some((keyword) => haystack.includes(keyword.toLowerCase()))
  ))?.id ?? null
}

function togglePostcardFilter(
  current: Record<PostcardFilterType, boolean>,
  target: PostcardFilterType,
): Record<PostcardFilterType, boolean> {
  const allEnabled = POSTCARD_FILTERS.every((filter) => current[filter.id])
  if (allEnabled) {
    return {
      temple: target === 'temple',
      transformer: target === 'transformer',
      church: target === 'church',
      park: target === 'park',
    }
  }
  return {
    ...current,
    [target]: !current[target],
  }
}

function isValidCoordinate(value: unknown): value is GPSCoordinate {
  if (!value || typeof value !== 'object') return false
  const coord = value as Partial<GPSCoordinate>
  return (
    typeof coord.latitude === 'number' &&
    typeof coord.longitude === 'number' &&
    Number.isFinite(coord.latitude) &&
    Number.isFinite(coord.longitude) &&
    coord.latitude >= -90 &&
    coord.latitude <= 90 &&
    coord.longitude >= -180 &&
    coord.longitude <= 180
  )
}

function normalizeImportedRoute(payload: RouteFilePayload): { name: string; waypoints: GPSCoordinate[] } {
  if (!Array.isArray(payload.waypoints)) {
    throw new Error('檔案格式錯誤，找不到路徑點資料')
  }
  const waypoints = payload.waypoints
  if (waypoints.length < 2) {
    throw new Error('路徑至少需要 2 個路徑點')
  }
  if (!waypoints.every(isValidCoordinate)) {
    throw new Error('路徑檔案內有無效座標，請確認經緯度')
  }
  const name = typeof payload.name === 'string' && payload.name.trim()
    ? payload.name.trim()
    : '匯入的種花路徑'
  return { name, waypoints }
}

function normalizeImportedLandmark(payload: LandmarkFilePayload): {
  name: string
  coordinate: GPSCoordinate
  landmarkType: 'flower' | 'mushroom' | 'postcard'
  region: string
} {
  const name = typeof payload.name === 'string' ? payload.name.trim() : ''
  if (!name) {
    throw new Error('地標檔案格式錯誤，缺少地標名稱')
  }
  if (!isValidCoordinate(payload.coordinate)) {
    throw new Error('地標檔案格式錯誤，座標必須包含有效 latitude 與 longitude')
  }
  if (payload.landmarkType !== 'flower' && payload.landmarkType !== 'mushroom' && payload.landmarkType !== 'postcard') {
    throw new Error('地標檔案格式錯誤，地標類型必須是 flower, mushroom 或 postcard')
  }
  return {
    name,
    coordinate: payload.coordinate,
    landmarkType: payload.landmarkType,
    region: typeof (payload as any).region === 'string' ? (payload as any).region : '未分類',
  }
}

function sanitizeFilename(value: string): string {
  const normalized = value.trim().replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, '-')
  return normalized || '未命名路徑'
}

function formatRouteCoordinates(route: SavedRoute): string {
  return route.waypoints
    .map((point) => `${point.latitude.toFixed(6)},${point.longitude.toFixed(6)}`)
    .join('\n')
}

function parseRouteCoordinateLines(value: string): GPSCoordinate[] {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  if (lines.length < 2) {
    throw new Error('路徑至少需要 2 個路徑點')
  }

  return lines.map((line, index) => {
    const parts = line.split(',').map((part) => part.trim())
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new Error(`第 ${index + 1} 行格式錯誤，請使用「緯度,經度」`)
    }

    const coordinate = {
      latitude: Number(parts[0]),
      longitude: Number(parts[1]),
    }
    if (!isValidCoordinate(coordinate)) {
      throw new Error(`第 ${index + 1} 行座標無效，請確認經緯度範圍`)
    }
    return coordinate
  })
}

async function copyTextToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.inset = '0 auto auto -9999px'
  document.body.appendChild(textarea)
  textarea.select()
  const copied = document.execCommand('copy')
  textarea.remove()
  if (!copied) throw new Error('Clipboard copy failed')
}

export default function App() {
  const [mode, setMode] = useState<Mode>('single')
  const [toasts, setToasts] = useState<Toast[]>([])
  const [myPosition, setMyPosition] = useState<GPSCoordinate | null>(null)
  const [viewTarget, setViewTarget] = useState<GPSCoordinate | null>(null)
  const [isMapClickArmed, setIsMapClickArmed] = useState(false)
  const [destinationInput, setDestinationInput] = useState('')
  const [isLocating, setIsLocating] = useState(false)
  const [isFlying, setIsFlying] = useState(false)
  const [hasResetGPS, setHasResetGPS] = useState(false)
  const [landmarkNameInput, setLandmarkNameInput] = useState('')
  const [landmarkCoordInput, setLandmarkCoordInput] = useState('')
  const [landmarkTypeInput, setLandmarkTypeInput] = useState<'flower' | 'mushroom' | 'postcard'>('mushroom')
  const [landmarkRegionInput, setLandmarkRegionInput] = useState('未分類')
  const [editingLandmarkId, setEditingLandmarkId] = useState('')
  const [landmarkSearchInput, setLandmarkSearchInput] = useState('')
  const [flyLandmarkSearchInput, setFlyLandmarkSearchInput] = useState('')
  const [routeSearchInput, setRouteSearchInput] = useState('')
  const [landmarkTypeFilter, setLandmarkTypeFilter] = useState<'all' | 'flower' | 'mushroom' | 'postcard'>('all')
  const [flyLandmarkTypeFilter, setFlyLandmarkTypeFilter] = useState<'all' | 'flower' | 'mushroom' | 'postcard'>('all')
  const [mapLayerFilter, setMapLayerFilter] = useState({
    flower: true,
    mushroom: false,
    postcard: false,
    region: 'all'
  })
  const [landmarkFormTouched, setLandmarkFormTouched] = useState(false)
  const [landmarkSaving, setLandmarkSaving] = useState(false)
  const [selectedLandmarkId, setSelectedLandmarkId] = useState('')
  const [openLandmarkActionId, setOpenLandmarkActionId] = useState('')
  const [openRouteActionId, setOpenRouteActionId] = useState('')
  const [savedRoutes, setSavedRoutes] = useState<SavedRoute[]>([])
  const [routeSaving, setRouteSaving] = useState(false)
  const [isManageModalOpen, setIsManageModalOpen] = useState(false)
  const [isFlySettingsOpen, setIsFlySettingsOpen] = useState(false)
  const [isLandmarkManagerOpen, setIsLandmarkManagerOpen] = useState(false)
  const [isRouteLibraryOpen, setIsRouteLibraryOpen] = useState(false)
  const [isSaveRouteModalOpen, setIsSaveRouteModalOpen] = useState(false)
  const [isRouteImportModalOpen, setIsRouteImportModalOpen] = useState(false)
  const [managerTab, setManagerTab] = useState<ManagerTab>('landmarks')
  const [landmarkManagerTab, setLandmarkManagerTab] = useState<LandmarkManagerTab>('create')
  const [landmarkPage, setLandmarkPage] = useState(1)
  const [flyLandmarkPage, setFlyLandmarkPage] = useState(1)
  const [routePage, setRoutePage] = useState(1)
  const [showPostcards, setShowPostcards] = useState(false)
  const [mapBounds, setMapBounds] = useState<MapBounds | null>(null)
  const [postcards, setPostcards] = useState<PostcardLandmark[]>([])
  const [postcardFilters, setPostcardFilters] = useState<Record<PostcardFilterType, boolean>>(INITIAL_POSTCARD_FILTERS)
  const [isScanningPostcards, setIsScanningPostcards] = useState(false)
  const [focusedPostcardId, setFocusedPostcardId] = useState('')
  const [postcardFocusTarget, setPostcardFocusTarget] = useState<GPSCoordinate | null>(null)
  const [previewPostcard, setPreviewPostcard] = useState<PostcardLandmark | null>(null)
  const [routeNameInput, setRouteNameInput] = useState('')
  const [routeImportMode, setRouteImportMode] = useState<RouteImportMode>('json')
  const [routeImportNameInput, setRouteImportNameInput] = useState('')
  const [routeImportCoordinatesInput, setRouteImportCoordinatesInput] = useState('')
  const [routeImporting, setRouteImporting] = useState(false)
  const [hasGeneratedFlowerRoute, setHasGeneratedFlowerRoute] = useState(false)
  const [generatedRouteSummary, setGeneratedRouteSummary] = useState<GeneratedRouteSummary | null>(null)
  const [flyMode, setFlyMode] = useState<FlyMode>('coordinate')
  const [savedLandmarks, setSavedLandmarks] = useState<SavedLandmark[]>([])
  const showToastRef = useRef<(message: string) => void>(() => {})
  const routeImportInputRef = useRef<HTMLInputElement | null>(null)
  const landmarkImportInputRef = useRef<HTMLInputElement | null>(null)
  const handleRouteError = useCallback((message: string) => {
    showToastRef.current(`路徑推送失敗：${message}`)
  }, [])

  const { devices, selectedDevice, selectDevice, isLoading, error } = useDevice()
  const {
    waypoints,
    addWaypoint,
    updateWaypoint,
    replaceWaypoints,
    removeWaypoint,
    clearWaypoints,
    routeStatus,
    startRoute,
    pauseRoute,
    resumeRoute,
    stopRoute,
    syncCurrentPosition,
  } = useRoute(selectedDevice?.id ?? null, myPosition, handleRouteError)
  const isPlanting = routeStatus.state === 'moving'

  useEffect(() => {
    if (!isPlanting) return

    setIsMapClickArmed(false)
    setIsManageModalOpen(false)
    setIsLandmarkManagerOpen(false)
    setIsFlySettingsOpen(false)
    setIsRouteLibraryOpen(false)
    setIsSaveRouteModalOpen(false)
  }, [isPlanting])

  useEffect(() => {
    let cancelled = false
    void apiClient.getLandmarks()
      .then((items) => {
        if (!cancelled) setSavedLandmarks(items)
      })
      .catch(() => {
        if (!cancelled) setSavedLandmarks([])
      })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    let cancelled = false
    void apiClient.getSavedRoutes()
      .then((items) => {
        if (!cancelled) setSavedRoutes(items)
      })
      .catch(() => {
        if (!cancelled) setSavedRoutes([])
      })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!selectedDevice || myPosition || hasResetGPS) return

    let cancelled = false
    const applyInitialPosition = (coord: GPSCoordinate) => {
      if (cancelled) return
      setMyPosition(coord)
      syncCurrentPosition(coord, 'idle')
      setViewTarget(coord)
    }
    const locateByBrowser = () => {
      if (!navigator.geolocation) return
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const coord = { latitude: pos.coords.latitude, longitude: pos.coords.longitude }
          applyInitialPosition(coord)
        },
        () => {},
      )
    }

    void apiClient.getGeolocation()
      .then((geo) => {
        applyInitialPosition({ latitude: geo.latitude, longitude: geo.longitude })
      })
      .catch(() => {
        locateByBrowser()
      })

    return () => { cancelled = true }
  }, [selectedDevice, myPosition, hasResetGPS, syncCurrentPosition])

  const showToast = useCallback((message: string) => {
    const id = ++toastIdCounter
    setToasts((prev) => [...prev, { id, message }])
    setTimeout(() => {
      setToasts((prev) => prev.filter((toast) => toast.id !== id))
    }, 3000)
  }, [])

  const visibleLandmarks = useMemo(() => {
    return savedLandmarks.filter(l => {
      if (mapLayerFilter.region !== 'all' && l.region !== mapLayerFilter.region) return false
      if (l.landmarkType === 'flower' && !mapLayerFilter.flower) return false
      if (l.landmarkType === 'mushroom' && !mapLayerFilter.mushroom) return false
      if (l.landmarkType === 'postcard' && !mapLayerFilter.postcard) return false
      return true
    })
  }, [savedLandmarks, mapLayerFilter])

  useEffect(() => {
    showToastRef.current = showToast
  }, [showToast])

  const handleScanPostcards = useCallback(async () => {
    if (!mapBounds) {
      showToast('目前還沒有可掃描的地圖範圍')
      return
    }

    const radiusM = boundsRadiusMeters(mapBounds)
    const limit = postcardLimitForRadius(radiusM)
    const boundsPayload = {
      north: mapBounds.north,
      south: mapBounds.south,
      east: mapBounds.east,
      west: mapBounds.west,
      limit,
    }
    setIsScanningPostcards(true)
    try {
      const [atlasItems, pikoohiongResult] = await Promise.all([
        apiClient.getPostcardsInBounds(boundsPayload),
        apiClient.getPostcardsInBounds(boundsPayload, 'pikoohiong').then(
          (items) => ({ ok: true as const, items }),
          () => ({ ok: false as const, items: [] as PostcardLandmark[] }),
        ),
      ])
      const items = mergePostcardSources(atlasItems, pikoohiongResult.items)
      setPostcards(items)
      const visibleCount = filterPostcardsInBounds(items, mapBounds, postcardFilters).length
      const supplementText = pikoohiongResult.ok
        ? `，輔助 ${pikoohiongResult.items.length} 筆`
        : '，輔助來源讀取失敗'
      showToast(`偵測到 ${visibleCount} 個${formatPostcardFilterLabel(postcardFilters)}（Atlas ${atlasItems.length} 筆${supplementText}）`)
    } catch (err) {
      setPostcards([])
      showToast(err instanceof Error ? err.message : '明信片掃描失敗')
    } finally {
      setIsScanningPostcards(false)
    }
  }, [mapBounds, postcardFilters, showToast])

  useEffect(() => {
    if (!showPostcards) {
      setPostcards([])
      setFocusedPostcardId('')
      setPostcardFocusTarget(null)
      setPreviewPostcard(null)
    }
  }, [showPostcards])

  useEffect(() => {
    if (!previewPostcard) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPreviewPostcard(null)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [previewPostcard])

  const handleFocusPostcard = useCallback((postcard: PostcardLandmark) => {
    setFocusedPostcardId(postcard.id)
    setPostcardFocusTarget({
      latitude: postcard.coordinate.latitude,
      longitude: postcard.coordinate.longitude,
    })
  }, [])

  useEffect(() => {
    setLandmarkPage(1)
  }, [landmarkSearchInput, landmarkTypeFilter])

  useEffect(() => {
    setFlyLandmarkPage(1)
  }, [flyLandmarkSearchInput, flyLandmarkTypeFilter])

  useEffect(() => {
    setRoutePage(1)
  }, [routeSearchInput])

  const resolveActiveDevice = useCallback(async () => {
    const latestDevices = await apiClient.getDevices()
    if (latestDevices.length === 0) return null
    const connected = latestDevices.find((item) => item.isConnected) ?? latestDevices[0]
    selectDevice(connected.id)
    return connected
  }, [selectDevice])

  const sendLocationFast = useCallback(async (coord: GPSCoordinate, preferredDeviceId?: string | null) => {
    let deviceId = preferredDeviceId ?? selectedDevice?.id ?? null
    if (!deviceId) {
      const refreshed = await resolveActiveDevice()
      if (!refreshed) {
        showToast('請先選擇裝置')
        return false
      }
      deviceId = refreshed.id
    }

    try {
      await apiClient.setLocation({
        latitude: coord.latitude,
        longitude: coord.longitude,
        deviceId,
      })
      return true
    } catch (err) {
      const status = typeof err === 'object' && err && 'status' in err ? (err as { status?: number }).status : undefined
      const code = typeof err === 'object' && err && 'code' in err ? (err as { code?: string }).code : undefined
      const message = err instanceof Error ? err.message : '設定位置失敗'

      if (code === 'LOCATION_BRIDGE_FAILED') {
        showToast('定位橋接失敗，請重試')
        return false
      }

      if (!(err instanceof Error) || !/Device not found|DEVICE_NOT_FOUND|HTTP 404|HTTP 400/i.test(message) || (status === 400 && code !== 'DEVICE_NOT_FOUND')) {
        showToast(message)
        return false
      }
      const refreshed = await resolveActiveDevice()
      if (!refreshed) {
        if (deviceId) {
          try {
            await new Promise((resolve) => window.setTimeout(resolve, 800))
            await apiClient.setLocation({
              latitude: coord.latitude,
              longitude: coord.longitude,
              deviceId,
            })
            return true
          } catch (retryErr) {
            const retryCode = typeof retryErr === 'object' && retryErr && 'code' in retryErr ? (retryErr as { code?: string }).code : undefined
            if (retryCode === 'LOCATION_BRIDGE_FAILED') {
              showToast('定位橋接失敗，請重試')
            } else {
              showToast(retryErr instanceof Error ? retryErr.message : '設定位置失敗')
            }
            return false
          }
        }
        showToast('裝置連線已變更，請重新選擇裝置後再試一次')
        return false
      }
      try {
        await apiClient.setLocation({
          latitude: coord.latitude,
          longitude: coord.longitude,
          deviceId: refreshed.id,
        })
        return true
      } catch (retryErr) {
        const retryCode = typeof retryErr === 'object' && retryErr && 'code' in retryErr ? (retryErr as { code?: string }).code : undefined
        if (retryCode === 'LOCATION_BRIDGE_FAILED') {
          showToast('定位橋接失敗，請重試')
        } else {
          showToast(retryErr instanceof Error ? retryErr.message : '設定位置失敗')
        }
        return false
      }
    }
  }, [resolveActiveDevice, selectedDevice?.id, showToast])

  const handleMapClick = useCallback(
    async (coord: GPSCoordinate) => {
      if (isPlanting) return
      if (!isMapClickArmed) return

      if (mode === 'route') {
        setHasGeneratedFlowerRoute(false)
        setGeneratedRouteSummary(null)
        addWaypoint(coord)
        return
      }

      const ok = await sendLocationFast(coord, selectedDevice?.id)
    if (!ok) return
    try {
      setIsFlying(true)
      setMyPosition(coord)
      syncCurrentPosition(coord, 'idle')
      setViewTarget(coord)
      setHasResetGPS(false)
      showToast('位置已更新')
    } catch (err) {
      showToast(err instanceof Error ? err.message : '設定位置失敗')
    } finally {
      setIsFlying(false)
    }
  },
  [addWaypoint, isMapClickArmed, isPlanting, mode, selectedDevice?.id, sendLocationFast, showToast, syncCurrentPosition],
)

  const handleToggleMapClickArmed = useCallback(() => {
    if (isPlanting) {
      showToast('種花中已鎖定點圖操作')
      return
    }
    setIsMapClickArmed((prev) => {
      const next = !prev
      showToast(next ? '點圖生效中' : '點圖已鎖定')
      return next
    })
  }, [isPlanting, showToast])

  const handleRemoveWaypoint = useCallback((index: number) => {
    setHasGeneratedFlowerRoute(false)
    setGeneratedRouteSummary(null)
    removeWaypoint(index)
    showToast('已移除路徑節點')
  }, [removeWaypoint, showToast])

  const handleCopyWaypointCoordinate = useCallback(async (index: number) => {
    const waypoint = waypoints[index]
    if (!waypoint) return

    try {
      await copyTextToClipboard(formatCoordinate(waypoint))
      showToast(`已複製節點 ${index + 1} 座標`)
    } catch {
      showToast('複製節點座標失敗')
    }
  }, [showToast, waypoints])

  const handleSetWaypointAsStart = useCallback((index: number) => {
    if (index <= 0 || index >= waypoints.length) return
    setHasGeneratedFlowerRoute(false)
    setGeneratedRouteSummary(null)
    replaceWaypoints([
      ...waypoints.slice(index),
      ...waypoints.slice(0, index),
    ])
    showToast('已設為起點')
  }, [replaceWaypoints, showToast, waypoints])

  const handleSetWaypointAsEnd = useCallback((index: number) => {
    if (index < 0 || index >= waypoints.length - 1) return
    const selected = waypoints[index]
    setHasGeneratedFlowerRoute(false)
    setGeneratedRouteSummary(null)
    replaceWaypoints([
      ...waypoints.slice(0, index),
      ...waypoints.slice(index + 1),
      selected,
    ])
    showToast('已設為終點')
  }, [replaceWaypoints, showToast, waypoints])

  const handleUpdateWaypoint = useCallback((index: number, coord: GPSCoordinate) => {
    setHasGeneratedFlowerRoute(false)
    setGeneratedRouteSummary(null)
    updateWaypoint(index, coord)
  }, [updateWaypoint])

  const handleGenerateFlowerRoute = useCallback((variant: FlowerRouteVariant) => {
    if (routeStatus.state !== 'idle' && routeStatus.state !== 'paused') {
      showToast('種花中不可重新產生路徑')
      return
    }
    if (waypoints.length < 3) {
      showToast('至少需要 3 個花點才能產生循環路線')
      return
    }

    const optimized = variant === 'best'
      ? optimizeFlowerRouteDeepSearch(waypoints)
      : optimizeFlowerRoute(waypoints)
    const totalDistance = calculateCycleDistanceMeters(optimized)
    replaceWaypoints(optimized)
    setHasGeneratedFlowerRoute(true)
    setGeneratedRouteSummary({
      variant,
      totalDistanceMeters: totalDistance,
    })
    showToast(variant === 'best' ? '已產生最佳路線' : '已快速產生循環綠線')
  }, [replaceWaypoints, routeStatus.state, showToast, waypoints])

  const handleStartRoute = useCallback(
    async (speed: number, loop: boolean) => {
      try {
        await startRoute(speed, loop)
      } catch (err) {
        if (err instanceof Error && 'status' in err && (err as { status: number }).status === 409) {
          try {
            await stopRoute()
            await startRoute(speed, loop)
          } catch (retryErr) {
            showToast(retryErr instanceof Error ? retryErr.message : '啟動路徑失敗')
          }
        } else {
          showToast(err instanceof Error ? err.message : '啟動路徑失敗')
        }
      }
    },
    [showToast, startRoute, stopRoute],
  )

  const handlePauseRoute = useCallback(async () => {
    try {
      await pauseRoute()
    } catch (err) {
      showToast(err instanceof Error ? err.message : '暫停路徑失敗')
    }
  }, [pauseRoute, showToast])

  const handleResumeRoute = useCallback(async () => {
    try {
      await resumeRoute()
    } catch (err) {
      showToast(err instanceof Error ? err.message : '繼續路徑失敗')
    }
  }, [resumeRoute, showToast])

  const handleStopRoute = useCallback(async () => {
    try {
      await stopRoute()
      showToast('✅ 已停止路徑')
    } catch (err) {
      showToast(err instanceof Error ? err.message : '停止路徑失敗')
    }
  }, [showToast, stopRoute])

  const locateByBrowser = useCallback(() => {
    if (!navigator.geolocation) {
      showToast('此瀏覽器不支援地理定位')
      return
    }
    setIsLocating(true)
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const coord = { latitude: pos.coords.latitude, longitude: pos.coords.longitude }
        if (selectedDevice) {
          sendLocationFast(coord, selectedDevice.id).then((ok) => {
            if (ok) {
              setMyPosition(coord)
              syncCurrentPosition(coord, 'idle')
              setViewTarget(coord)
              setHasResetGPS(false)
              setIsLocating(false)
              showToast('位置取得成功')
            }
          }).catch(console.error)
        } else {
          setMyPosition(coord)
          syncCurrentPosition(coord, 'idle')
          setViewTarget(coord)
          setHasResetGPS(false)
          setIsLocating(false)
          showToast('位置取得成功')
        }
      },
      (err) => {
        setIsLocating(false)
        showToast(`無法取得位置：${err.message}`)
      },
      { enableHighAccuracy: true, timeout: 10000 }
    )
  }, [selectedDevice, showToast, syncCurrentPosition, sendLocationFast])

  const handleFlyTo = useCallback(async (latitude: number, longitude: number) => {
    if (!selectedDevice) return
    try {
      setViewTarget({ latitude, longitude })
      await apiClient.setLocation({
        latitude,
        longitude,
        deviceId: selectedDevice.id,
      })
      showToast('已設定虛擬定位')
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err))
    }
  }, [selectedDevice, showToast])

  const handleFlyToDestination = useCallback(async () => {
    const landmark = savedLandmarks.find((item) => item.name === destinationInput.trim())
    const coord = landmark?.coordinate ?? parseCoordinateInput(destinationInput)
    if (!coord) {
      showToast('請輸入正確目的地座標')
      return
    }

    setIsFlying(true)
    try {
      const ok = await sendLocationFast(coord, selectedDevice?.id)
      if (!ok) return
      setMode('single')
      setMyPosition(coord)
      syncCurrentPosition(coord, 'idle')
      setViewTarget(coord)
      setHasResetGPS(false)
      setDestinationInput(landmark ? landmark.name : '')
      showToast('已飛行到目的地')
    } catch (err) {
      showToast(err instanceof Error ? err.message : '飛行失敗')
    } finally {
      setIsFlying(false)
    }
  }, [destinationInput, savedLandmarks, selectedDevice?.id, sendLocationFast, showToast, syncCurrentPosition])

  const selectedFlyLandmark = savedLandmarks.find((item) => item.id === selectedLandmarkId) ?? null
  const flyTargetText = flyMode === 'landmark'
    ? (selectedFlyLandmark?.name || '尚未選擇地標')
    : (parseCoordinateInput(destinationInput) ? destinationInput.trim() : '尚未輸入有效座標')

  const handleSaveLandmark = useCallback(async () => {
    setLandmarkFormTouched(true)
    const target = parseCoordinateInput(landmarkCoordInput)
    if (!target) {
      setLandmarkCoordInput('')
      showToast('座標無效，請重新輸入，例如：25.033, 121.565')
      return
    }
    const name = landmarkNameInput.trim()
    if (!name) {
      showToast('請先輸入地標名稱')
      return
    }

    try {
      setLandmarkSaving(true)
      if (editingLandmarkId) {
        const updated = await apiClient.updateLandmark(editingLandmarkId, { name, coordinate: target, landmarkType: landmarkTypeInput, region: landmarkRegionInput })
        setSavedLandmarks((prev) => prev.map((landmark) => landmark.id === updated.id ? updated : landmark))
        if (selectedLandmarkId === updated.id) {
          setDestinationInput(updated.name)
        }
        showToast('地標已更新')
      } else {
        const created = await apiClient.createLandmark({ name, coordinate: target, landmarkType: landmarkTypeInput, region: landmarkRegionInput })
        setSavedLandmarks((prev) => [created, ...prev])
        showToast('地標已儲存')
      }
      setLandmarkNameInput('')
      setLandmarkCoordInput('')
      setLandmarkTypeInput('mushroom')
      setLandmarkRegionInput('未分類')
      setEditingLandmarkId('')
      setLandmarkFormTouched(false)
    } catch (err) {
      showToast(err instanceof Error ? err.message : editingLandmarkId ? '更新地標失敗' : '儲存地標失敗')
    } finally {
      setLandmarkSaving(false)
    }
  }, [editingLandmarkId, landmarkCoordInput, landmarkNameInput, landmarkTypeInput, selectedLandmarkId, showToast])

  const handleEditLandmark = useCallback((landmark: SavedLandmark) => {
    setEditingLandmarkId(landmark.id)
    setLandmarkManagerTab('create')
    setLandmarkNameInput(landmark.name)
    setLandmarkCoordInput(formatCoordinate(landmark.coordinate))
    setLandmarkTypeInput(landmark.landmarkType)
    setLandmarkFormTouched(false)
  }, [])

  const handleCancelLandmarkEdit = useCallback(() => {
    setEditingLandmarkId('')
    setLandmarkNameInput('')
    setLandmarkCoordInput('')
    setLandmarkTypeInput('mushroom')
    setLandmarkFormTouched(false)
  }, [])

  const handleDeleteLandmark = useCallback(async (id: string) => {
    try {
      await apiClient.deleteLandmark(id)
      setSavedLandmarks((prev) => prev.filter((landmark) => landmark.id !== id))
    } catch (err) {
      showToast(err instanceof Error ? err.message : '刪除地標失敗')
      return
    }
    if (selectedLandmarkId === id) {
      setSelectedLandmarkId('')
    }
    if (editingLandmarkId === id) {
      handleCancelLandmarkEdit()
    }
  }, [editingLandmarkId, handleCancelLandmarkEdit, selectedLandmarkId, showToast])

  const handleExportLandmark = useCallback((landmark: SavedLandmark) => {
    const payload = {
      name: landmark.name,
      coordinate: landmark.coordinate,
      landmarkType: landmark.landmarkType,
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `pikomin-landmark-${sanitizeFilename(landmark.name)}.json`
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
    showToast(`已匯出地標：${landmark.name}`)
  }, [showToast])

  const handleCopyLandmarkCoordinate = useCallback(async (landmark: SavedLandmark) => {
    try {
      await copyTextToClipboard(formatCoordinate(landmark.coordinate))
      showToast(`已複製地標座標：${landmark.name}`)
    } catch {
      showToast('複製地標座標失敗')
    }
  }, [showToast])

  const handleImportLandmarkFile = useCallback(async (file: File | null) => {
    if (!file) return
    if (!file.name.toLowerCase().endsWith('.json')) {
      showToast('檔案格式錯誤，請選擇地標 JSON 檔')
      return
    }

    try {
      const text = await file.text()
      const payload = JSON.parse(text) as LandmarkFilePayload
      const imported = normalizeImportedLandmark(payload)
      const created = await apiClient.createLandmark(imported)
      setSavedLandmarks((prev) => [created, ...prev])
      showToast(`地標已匯入：${created.name}`)
    } catch (err) {
      if (err instanceof SyntaxError) {
        showToast('檔案格式錯誤，請選擇地標 JSON 檔')
        return
      }
      showToast(err instanceof Error ? err.message : '匯入地標失敗')
    }
  }, [showToast])

  const handleAddPostcardLandmark = useCallback(async (postcard: PostcardLandmark) => {
    try {
      const created = await apiClient.createLandmark({
        name: postcard.name,
        coordinate: postcard.coordinate,
        landmarkType: 'flower',
        region: postcard.city || postcard.country || '未分類',
      })
      setSavedLandmarks((prev) => {
        if (prev.some((landmark) => landmark.id === created.id)) return prev
        return [created, ...prev]
      })
      showToast(`已加入地標：${postcard.name}`)
    } catch (err) {
      showToast(err instanceof Error ? err.message : '加入地標失敗')
    }
  }, [showToast])

  const handleSelectLandmarkToFly = useCallback((landmarkName: string) => {
    setDestinationInput(landmarkName)
    const target = savedLandmarks.find((item) => item.name === landmarkName)
    if (!target) return
    setSelectedLandmarkId(target.id)
  }, [savedLandmarks])

  const handleOpenSaveRouteModal = useCallback(() => {
    if (waypoints.length < 2) {
      showToast('路徑至少需要 2 個路徑點')
      return
    }

    setRouteNameInput('')
    setIsSaveRouteModalOpen(true)
  }, [showToast, waypoints.length])

  const handleCloseSaveRouteModal = useCallback(() => {
    if (routeSaving) return
    setIsSaveRouteModalOpen(false)
    setRouteNameInput('')
  }, [routeSaving])

  const handleOpenRouteImportModal = useCallback(() => {
    setRouteImportMode('json')
    setRouteImportNameInput('')
    setRouteImportCoordinatesInput('')
    setIsRouteImportModalOpen(true)
  }, [])

  const handleOpenRouteImportFromManager = useCallback(() => {
    setIsLandmarkManagerOpen(false)
    setOpenRouteActionId('')
    setRouteImportMode('json')
    setRouteImportNameInput('')
    setRouteImportCoordinatesInput('')
    setIsRouteImportModalOpen(true)
  }, [])

  const handleCloseRouteImportModal = useCallback(() => {
    if (routeImporting) return
    setIsRouteImportModalOpen(false)
    setRouteImportNameInput('')
    setRouteImportCoordinatesInput('')
  }, [routeImporting])

  const handleConfirmSaveRoute = useCallback(async () => {
    if (routeSaving) return
    if (waypoints.length < 2) {
      showToast('路徑至少需要 2 個路徑點')
      setIsSaveRouteModalOpen(false)
      return
    }

    const name = routeNameInput.trim()
    if (!name) {
      showToast('請輸入路徑名稱')
      return
    }

    try {
      setRouteSaving(true)
      const created = await apiClient.createSavedRoute({ name, waypoints })
      setSavedRoutes((prev) => [created, ...prev])
      setIsSaveRouteModalOpen(false)
      setRouteNameInput('')
      showToast('路徑已儲存')
    } catch (err) {
      showToast(err instanceof Error ? err.message : '儲存路徑失敗')
    } finally {
      setRouteSaving(false)
    }
  }, [routeNameInput, routeSaving, showToast, waypoints])

  const handleLoadSavedRoute = useCallback((route: SavedRoute) => {
    if (routeStatus.state !== 'idle') {
      showToast('路徑執行中，請先停止後再載入')
      return
    }
    setHasGeneratedFlowerRoute(false)
    setGeneratedRouteSummary(null)
    replaceWaypoints(route.waypoints)
    setMode('route')
    if (route.waypoints.length > 0) {
      setViewTarget({ ...route.waypoints[0] })
    }
    setIsRouteLibraryOpen(false)
    showToast(`已載入路徑：${route.name}`)
  }, [replaceWaypoints, routeStatus.state, showToast])

  const handleDeleteSavedRoute = useCallback(async (id: string) => {
    try {
      await apiClient.deleteSavedRoute(id)
      setSavedRoutes((prev) => prev.filter((route) => route.id !== id))
      showToast('路徑已刪除')
    } catch (err) {
      showToast(err instanceof Error ? err.message : '刪除路徑失敗')
    }
  }, [showToast])

  const handleExportSavedRoute = useCallback((route: SavedRoute) => {
    const payload = {
      name: route.name,
      waypoints: route.waypoints,
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `pikomin-route-${sanitizeFilename(route.name)}.json`
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
    showToast(`已匯出路徑：${route.name}`)
  }, [showToast])

  const handleCopyRouteCoordinates = useCallback(async (route: SavedRoute) => {
    try {
      await copyTextToClipboard(formatRouteCoordinates(route))
      showToast(`已複製路徑節點：${route.name}`)
    } catch {
      showToast('複製路徑節點失敗')
    }
  }, [showToast])

  const handleImportRouteFile = useCallback(async (file: File | null) => {
    if (!file) return
    if (!file.name.toLowerCase().endsWith('.json')) {
      showToast('檔案格式錯誤，請選擇種花路徑 JSON 檔')
      return
    }

    try {
      setRouteImporting(true)
      const text = await file.text()
      const payload = JSON.parse(text) as RouteFilePayload
      const imported = normalizeImportedRoute(payload)
      const name = routeImportNameInput.trim()
      if (name) imported.name = name
      const created = await apiClient.createSavedRoute(imported)
      setSavedRoutes((prev) => [created, ...prev])
      setIsRouteImportModalOpen(false)
      setRouteImportNameInput('')
      setRouteImportCoordinatesInput('')
      showToast('路徑已匯入，可從讀取路徑選擇')
    } catch (err) {
      if (err instanceof SyntaxError) {
        showToast('檔案格式錯誤，請選擇種花路徑 JSON 檔')
        return
      }
      showToast(err instanceof Error ? err.message : '匯入路徑失敗')
    } finally {
      setRouteImporting(false)
    }
  }, [routeImportNameInput, showToast])

  const handleConfirmImportCoordinates = useCallback(async () => {
    if (routeImporting) return

    const name = routeImportNameInput.trim() || '貼上的種花路徑'
    try {
      setRouteImporting(true)
      const waypoints = parseRouteCoordinateLines(routeImportCoordinatesInput)
      const created = await apiClient.createSavedRoute({ name, waypoints })
      setSavedRoutes((prev) => [created, ...prev])
      setIsRouteImportModalOpen(false)
      setRouteImportNameInput('')
      setRouteImportCoordinatesInput('')
      showToast('路徑已匯入，可從讀取路徑選擇')
    } catch (err) {
      showToast(err instanceof Error ? err.message : '匯入路徑失敗')
    } finally {
      setRouteImporting(false)
    }
  }, [routeImportCoordinatesInput, routeImportNameInput, routeImporting, showToast])

  const currentPosition = routeStatus.currentPosition ?? myPosition
  const handleSwitchFlyMode = useCallback((nextMode: FlyMode) => {
    if (nextMode === flyMode) return
    setFlyMode(nextMode)
    setDestinationInput('')
    setSelectedLandmarkId('')
  }, [flyMode])

  const showDisconnectBanner = !isLoading && selectedDevice === null
  const trimmedLandmarkName = landmarkNameInput.trim()
  const parsedLandmarkCoord = parseCoordinateInput(landmarkCoordInput)
  const nameError = landmarkFormTouched && !trimmedLandmarkName ? '請輸入地標名稱' : ''
  const coordError = landmarkFormTouched && !parsedLandmarkCoord ? '座標格式錯誤，請用 25.033, 121.565' : ''
  const isLandmarkFormValid = Boolean(trimmedLandmarkName && parsedLandmarkCoord)
  const normalizedSearchKeyword = landmarkSearchInput.trim().toLowerCase()
  const filteredLandmarks = savedLandmarks.filter((landmark) => {
    const typeMatched = landmarkTypeFilter === 'all' || landmark.landmarkType === landmarkTypeFilter
    if (!normalizedSearchKeyword) return typeMatched
    const nameMatched = landmark.name.toLowerCase().includes(normalizedSearchKeyword)
    const coordText = formatCoordinate(landmark.coordinate).toLowerCase()
    const coordMatched = coordText.includes(normalizedSearchKeyword)
    return typeMatched && (nameMatched || coordMatched)
  })
  const landmarkPageCount = Math.max(1, Math.ceil(filteredLandmarks.length / LANDMARKS_PER_PAGE))
  const safeLandmarkPage = Math.min(landmarkPage, landmarkPageCount)
  const pagedLandmarks = filteredLandmarks.slice(
    (safeLandmarkPage - 1) * LANDMARKS_PER_PAGE,
    safeLandmarkPage * LANDMARKS_PER_PAGE,
  )
  const normalizedFlyLandmarkSearchKeyword = flyLandmarkSearchInput.trim().toLowerCase()
  const filteredFlyLandmarks = savedLandmarks.filter((landmark) => {
    const typeMatched = flyLandmarkTypeFilter === 'all' || landmark.landmarkType === flyLandmarkTypeFilter
    if (!normalizedFlyLandmarkSearchKeyword) return typeMatched
    const nameMatched = landmark.name.toLowerCase().includes(normalizedFlyLandmarkSearchKeyword)
    const coordText = formatCoordinate(landmark.coordinate).toLowerCase()
    const coordMatched = coordText.includes(normalizedFlyLandmarkSearchKeyword)
    return typeMatched && (nameMatched || coordMatched)
  })
  const flyLandmarkPageCount = Math.max(1, Math.ceil(filteredFlyLandmarks.length / LANDMARKS_PER_PAGE))
  const safeFlyLandmarkPage = Math.min(flyLandmarkPage, flyLandmarkPageCount)
  const pagedFlyLandmarks = filteredFlyLandmarks.slice(
    (safeFlyLandmarkPage - 1) * LANDMARKS_PER_PAGE,
    safeFlyLandmarkPage * LANDMARKS_PER_PAGE,
  )
  const normalizedRouteSearchKeyword = routeSearchInput.trim().toLowerCase()
  const filteredSavedRoutes = savedRoutes.filter((route) => {
    if (!normalizedRouteSearchKeyword) return true
    return route.name.toLowerCase().includes(normalizedRouteSearchKeyword)
  })
  const routePageCount = Math.max(1, Math.ceil(filteredSavedRoutes.length / ROUTES_PER_PAGE))
  const safeRoutePage = Math.min(routePage, routePageCount)
  const pagedSavedRoutes = filteredSavedRoutes.slice(
    (safeRoutePage - 1) * ROUTES_PER_PAGE,
    safeRoutePage * ROUTES_PER_PAGE,
  )
  const canEditRouteWaypoints = mode === 'route' && (
    routeStatus.state === 'idle' ||
    routeStatus.state === 'paused'
  )
  const allPostcardFiltersEnabled = POSTCARD_FILTERS.every((filter) => postcardFilters[filter.id])
  const visiblePostcards = showPostcards && mapBounds
    ? filterPostcardsInBounds(postcards, mapBounds, postcardFilters)
    : []

  return (
    <div className="app-shell">
      <section className="map-stage map-stage-full">
        <MapInterface
          mode={mode}
          currentPosition={currentPosition}
          viewTarget={viewTarget}
          waypoints={waypoints}
          savedLandmarks={visibleLandmarks}
          postcardLandmarks={visiblePostcards}
          showPostcards={showPostcards}
          focusedPostcardId={focusedPostcardId}
          postcardFocusTarget={postcardFocusTarget}
          onViewportChange={setMapBounds}
          onPostcardAddLandmark={handleAddPostcardLandmark}
          onPostcardAction={showToast}
          onMapClick={handleMapClick}
          onWaypointMove={handleUpdateWaypoint}
          onWaypointRemove={handleRemoveWaypoint}
          onWaypointCopyCoordinate={handleCopyWaypointCoordinate}
          onWaypointSetAsStart={handleSetWaypointAsStart}
          onWaypointSetAsEnd={handleSetWaypointAsEnd}
          canEditWaypoints={canEditRouteWaypoints}
          showGeneratedFlowerRoute={hasGeneratedFlowerRoute}
        />
      </section>

      <div className="overlay-shell">
        <main className="workspace workspace-overlay">
          {showPostcards ? (
            <aside className="sidebar sidebar-floating postcard-browser-sidebar">
              <section className="panel panel-hero postcard-browser-panel">
                <div className="panel-heading">
                  <div>
                    <p className="panel-kicker">明信片瀏覽</p>
                    <h2>{visiblePostcards.length} 個座標點</h2>
                  </div>
                </div>

                <div className="postcard-list-head">
                  <span>掃描到的明信片</span>
                  <small>{visiblePostcards.length} / {postcards.length} 筆</small>
                </div>
                {postcards.length === 0 ? (
                  <p className="route-empty">還沒有掃描結果。按「掃描目前畫面」取得地圖範圍內的明信片。</p>
                ) : visiblePostcards.length === 0 ? (
                  <p className="route-empty">目前篩選條件下沒有明信片，請調整類型或重新掃描。</p>
                ) : (
                  <div className="postcard-result-list">
                    {visiblePostcards.map((postcard) => (
                      <div
                        key={postcard.id}
                        className={`postcard-result-item${focusedPostcardId === postcard.id ? ' is-focused' : ''}`}
                        role="button"
                        tabIndex={0}
                        onClick={() => handleFocusPostcard(postcard)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault()
                            handleFocusPostcard(postcard)
                          }
                        }}
                      >
                        <span className="postcard-result-thumb">
                          <span className="postcard-result-thumb-fallback">
                            <Mail size={18} strokeWidth={2.4} />
                          </span>
                          {postcard.imageUrl && (
                            <img
                              src={postcard.imageUrl}
                              alt=""
                              loading="lazy"
                              referrerPolicy="no-referrer"
                              onError={(event) => {
                                event.currentTarget.remove()
                              }}
                            />
                          )}
                          {postcard.imageUrl && (
                            <button
                              type="button"
                              className="postcard-preview-button"
                              aria-label={`查看明信片大圖：${postcard.name}`}
                              title="查看大圖"
                              onClick={(event) => {
                                event.stopPropagation()
                                setPreviewPostcard(postcard)
                              }}
                            >
                              <Search size={14} strokeWidth={2.6} />
                            </button>
                          )}
                          <span className="postcard-result-dot" />
                        </span>
                        <span className="postcard-result-main">
                          <strong>{postcard.name}</strong>
                          <small>{formatCoordinate(postcard.coordinate)}</small>
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </aside>
          ) : (
          <aside className="sidebar sidebar-floating">
          <section className="panel panel-hero">
            <div className="panel-heading">
              <div>
                <p className="panel-kicker">
                  裝置與狀態
                  <span className="version-badge">v{__APP_VERSION__}</span>
                </p>
                <h2>
                  {currentPosition ? formatCoordinate(currentPosition) : '尚未設定定位座標'}
                  {showDisconnectBanner && (
                    <span className="disconnect-status">
                      <span className="inline-alert">未偵測到裝置</span>
                    </span>
                  )}
                </h2>
              </div>
            </div>

            <DeviceStatus
              devices={devices}
              selectedDevice={selectedDevice}
              onSelectDevice={selectDevice}
              isLoading={isLoading}
              error={error}
            />

            <LocationSearch
              onLocationSelect={handleFlyTo}
              disabled={isPlanting}
            />

            <label className="field">
              <span>地圖圖層顯示</span>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '8px', fontSize: '13px' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer' }}>
                  <input type="checkbox" checked={mapLayerFilter.flower} onChange={(e) => setMapLayerFilter(prev => ({ ...prev, flower: e.target.checked }))} /> 花點
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer' }}>
                  <input type="checkbox" checked={mapLayerFilter.mushroom} onChange={(e) => setMapLayerFilter(prev => ({ ...prev, mushroom: e.target.checked }))} /> 菇點
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer' }}>
                  <input type="checkbox" checked={mapLayerFilter.postcard} onChange={(e) => setMapLayerFilter(prev => ({ ...prev, postcard: e.target.checked }))} /> 明信片
                </label>
              </div>
              <select value={mapLayerFilter.region} onChange={(e) => setMapLayerFilter(prev => ({ ...prev, region: e.target.value }))}>
                <option value="all">所有地區</option>
                {Array.from(new Set(savedLandmarks.map(l => l.region).filter(Boolean))).map(r => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            </label>

            <label className="field">
              <span>操作模式</span>
              <div className="mode-control-row">
                <select
                  value={mode}
                  onChange={(e) => {
                    const newMode = e.target.value as Mode
                    setMode(newMode)
                    if (newMode === 'route' && waypoints.length > 0) {
                      setViewTarget({ ...waypoints[0] })
                    }
                  }}
                  aria-label="操作模式"
                >
                  <option value="single">單點定位</option>
                  <option value="route">路徑模式</option>
                </select>
                <div className="mode-field-actions">
                  <button
                    className={`icon-button mode-action-button${isMapClickArmed ? ' is-active' : ''}`}
                    onClick={handleToggleMapClickArmed}
                    aria-label={isPlanting ? '種花中已鎖定點圖操作' : isMapClickArmed ? '關閉點圖生效' : '開啟點圖生效'}
                    aria-pressed={isMapClickArmed}
                    title={isPlanting ? '種花中已鎖定點圖操作' : isMapClickArmed ? '點圖生效中' : '點圖已鎖定'}
                    disabled={isPlanting}
                    type="button"
                  >
                    {isMapClickArmed ? (
                      <MousePointerClick aria-hidden="true" size={16} strokeWidth={2.4} />
                    ) : (
                      <Lock aria-hidden="true" size={16} strokeWidth={2.4} />
                    )}
                  </button>
                  <button
                    className="icon-button mode-action-button"
                    onClick={() => setIsManageModalOpen(true)}
                    aria-label={isPlanting ? '種花中不可調整位置設定' : '位置設定'}
                    title={isPlanting ? '種花中不可調整位置設定' : '位置設定'}
                    disabled={isPlanting}
                    type="button"
                  >
                    <Map aria-hidden="true" size={16} strokeWidth={2.4} />
                  </button>
                </div>
              </div>
            </label>
            <p className="helper-text" aria-live="polite">
              {isPlanting
                ? '種花中已鎖定點圖操作與位置設定，停止後可重新調整'
                : !isMapClickArmed
                ? '地圖點擊目前已鎖定，開啟「點圖生效」後才會寫入位置或新增路徑點'
                : mode === 'single'
                  ? '點擊地圖直接移動裝置定位'
                : '點擊地圖加入路徑點'}
            </p>

            <div className="inline-route-panel">
              <RoutePanel
                waypoints={waypoints}
                routeStatus={routeStatus}
                hasGeneratedFlowerRoute={hasGeneratedFlowerRoute}
                generatedRouteSummary={generatedRouteSummary}
                onGenerateFlowerRoute={handleGenerateFlowerRoute}
                onStartRoute={handleStartRoute}
                onPauseRoute={handlePauseRoute}
                onResumeRoute={handleResumeRoute}
                onStopRoute={handleStopRoute}
              />
            </div>
          </section>
          </aside>
          )}
        </main>

        <aside className="route-data-sidebar">
          <section className="route-data-panel">
            <div className="route-toolbar" aria-label="路徑工具">
              {mode === 'single' && (
                <button
                  className={`icon-button route-toolbar-button${showPostcards ? ' is-active' : ''}`}
                  onClick={() => setShowPostcards((current) => !current)}
                  aria-label={showPostcards ? `關閉明信片圖層，目前顯示 ${visiblePostcards.length} 張` : '開啟明信片圖層'}
                  aria-pressed={showPostcards}
                  title={showPostcards ? `明信片：${visiblePostcards.length} 張` : '明信片圖層'}
                  type="button"
                >
                  <Mail aria-hidden="true" {...ROUTE_TOOLBAR_ICON_PROPS} />
                </button>
              )}
              {mode === 'single' && showPostcards && (
                <div className="postcard-filter-stack" aria-label="明信片類型篩選">
                  <button
                    type="button"
                    className={`postcard-filter-chip${allPostcardFiltersEnabled ? ' is-active' : ''}`}
                    aria-pressed={allPostcardFiltersEnabled}
                    aria-label="顯示全部類型明信片"
                    title="全部"
                    onClick={() => setPostcardFilters(INITIAL_POSTCARD_FILTERS)}
                  >
                    <Layers3 aria-hidden="true" size={18} strokeWidth={2.4} />
                  </button>
                  {POSTCARD_FILTERS.map((filter) => (
                    <button
                      key={filter.id}
                      type="button"
                      className={`postcard-filter-chip${postcardFilters[filter.id] ? ' is-active' : ''}`}
                      aria-pressed={postcardFilters[filter.id]}
                      aria-label={`${postcardFilters[filter.id] ? '隱藏' : '顯示'}${filter.label}明信片`}
                      title={filter.label}
                      onClick={() => setPostcardFilters((current) => togglePostcardFilter(current, filter.id))}
                    >
                      {postcardFilterIcon(filter.id)}
                    </button>
                  ))}
                  <button
                    type="button"
                    className={`postcard-filter-chip postcard-scan-button${isScanningPostcards ? ' is-loading' : ''}`}
                    aria-label="掃描目前畫面明信片"
                    title={isScanningPostcards ? '掃描中' : '掃描目前畫面'}
                    disabled={isScanningPostcards}
                    onClick={() => void handleScanPostcards()}
                  >
                    {isScanningPostcards ? (
                      <Loader2 aria-hidden="true" size={18} strokeWidth={2.4} />
                    ) : (
                      <Radar aria-hidden="true" size={18} strokeWidth={2.4} />
                    )}
                  </button>
                </div>
              )}
              {mode === 'route' && routeStatus.state === 'idle' && (
                  <>
                    {waypoints.length > 0 && (
                      <button
                        className="icon-button route-toolbar-button"
                        onClick={handleOpenSaveRouteModal}
                        disabled={routeSaving}
                        aria-label="儲存目前路徑"
                        title="儲存目前路徑"
                        type="button"
                      >
                        <Save aria-hidden="true" {...ROUTE_TOOLBAR_ICON_PROPS} />
                      </button>
                    )}
                    <button
                      className="icon-button route-toolbar-button"
                      onClick={handleOpenRouteImportModal}
                      aria-label="匯入路徑"
                      title="匯入路徑"
                      type="button"
                    >
                      <FileInput aria-hidden="true" {...ROUTE_TOOLBAR_ICON_PROPS} />
                    </button>
                    <button
                      className="icon-button route-toolbar-button"
                      onClick={() => setIsRouteLibraryOpen(true)}
                      aria-label="讀取路徑"
                      title="讀取路徑"
                      type="button"
                    >
                      <FolderOpen aria-hidden="true" {...ROUTE_TOOLBAR_ICON_PROPS} />
                    </button>
                    {waypoints.length > 0 && (
                      <button
                        className="icon-button danger route-toolbar-button"
                        onClick={() => {
                          setHasGeneratedFlowerRoute(false)
                          setGeneratedRouteSummary(null)
                          clearWaypoints()
                        }}
                        aria-label="清除全部路徑點"
                        title="清除全部路徑點"
                        type="button"
                      >
                        <Trash2 aria-hidden="true" {...ROUTE_TOOLBAR_ICON_PROPS} />
                      </button>
                    )}
                  </>
              )}
              <input
                ref={routeImportInputRef}
                className="sr-only"
                type="file"
                accept="application/json,.json"
                onChange={(e) => {
                  const file = e.target.files?.[0] ?? null
                  void handleImportRouteFile(file)
                  e.currentTarget.value = ''
                }}
              />
            </div>
          </section>
        </aside>
      </div>

      <div className="toast-container" role="status" aria-live="polite" aria-atomic="false">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`toast ${toast.message.startsWith('✅') ? 'is-success' : ''}`}
          >
            {toast.message}
          </div>
        ))}
      </div>

      {previewPostcard && (
        <div className="postcard-preview-backdrop" onClick={() => setPreviewPostcard(null)}>
          <section
            className="postcard-preview-panel"
            aria-modal="true"
            role="dialog"
            aria-label={`明信片大圖：${previewPostcard.name}`}
            onClick={(event) => event.stopPropagation()}
          >
            <header className="postcard-preview-head">
              <div>
                <strong>{previewPostcard.name}</strong>
                <small>{formatCoordinate(previewPostcard.coordinate)}</small>
              </div>
              <button
                type="button"
                className="postcard-preview-close"
                aria-label="關閉明信片大圖"
                onClick={() => setPreviewPostcard(null)}
              >
                <X size={22} strokeWidth={2.6} />
              </button>
            </header>
            <div className="postcard-preview-image-frame">
              <img
                src={previewPostcard.imageUrl}
                alt={previewPostcard.name}
                referrerPolicy="no-referrer"
              />
            </div>
          </section>
        </div>
      )}

      {isManageModalOpen && (
        <div className="modal-backdrop" onClick={() => setIsManageModalOpen(false)}>
          <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>位置資訊設定</h3>
            </div>
            <div className="modal-body">
              <section className="modal-section">
                <button className="primary-button" onClick={locateByBrowser} disabled={isLocating}>
                  {isLocating ? '定位中...' : '重新取得目前位置'}
                </button>
                <button
                  className="ghost-button modal-stack-button"
                  onClick={() => {
                    setManagerTab('landmarks')
                    setIsLandmarkManagerOpen(true)
                  }}
                >
                  地標 / 路徑管理
                </button>
                <button className="secondary-button modal-stack-button" onClick={() => setIsFlySettingsOpen(true)}>飛行設定</button>
                <p className="helper-text">已儲存 {savedLandmarks.length} 個地標，可在飛行設定中直接搜尋。</p>
              </section>
            </div>
          </div>
        </div>
      )}

      {isSaveRouteModalOpen && (
        <div className="modal-backdrop" onClick={handleCloseSaveRouteModal}>
          <div className="modal-panel modal-panel-narrow" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>儲存路徑</h3>
            </div>
            <div className="modal-body">
              <label className="field">
                <span>路徑名稱</span>
                <input
                  value={routeNameInput}
                  onChange={(e) => setRouteNameInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void handleConfirmSaveRoute()
                    if (e.key === 'Escape') handleCloseSaveRouteModal()
                  }}
                  placeholder="例如：機場巡點 A"
                  disabled={routeSaving}
                  autoFocus
                />
              </label>
              <p className="helper-text">目前路徑共有 {waypoints.length} 個路徑點。</p>
              <div className="modal-actions">
                <button
                  className="ghost-button"
                  onClick={handleCloseSaveRouteModal}
                  disabled={routeSaving}
                  type="button"
                >
                  取消
                </button>
                <button
                  className="primary-button"
                  onClick={() => void handleConfirmSaveRoute()}
                  disabled={routeSaving || !routeNameInput.trim()}
                  type="button"
                >
                  {routeSaving ? '儲存中...' : '確認儲存'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {isRouteImportModalOpen && (
        <div className="modal-backdrop" onClick={handleCloseRouteImportModal}>
          <div
            className={`modal-panel route-import-panel${routeImportMode === 'coordinates' ? ' is-two-column' : ''}`}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <h3>匯入路徑</h3>
            </div>
            <div className="modal-body route-import-body">
              <div className="route-import-layout">
                <section className="route-import-section">
                  <label className="field">
                    <span>路徑名稱</span>
                    <input
                      value={routeImportNameInput}
                      onChange={(e) => setRouteImportNameInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') handleCloseRouteImportModal()
                      }}
                      placeholder={routeImportMode === 'json' ? '留空則使用 JSON 內的名稱' : '例如：義大利種花 01'}
                      disabled={routeImporting}
                      autoFocus
                    />
                  </label>
                  <div className="field">
                    <span>匯入方式</span>
                    <div className="segmented-control route-import-tabs" role="tablist" aria-label="路徑匯入方式">
                      <button
                        type="button"
                        className={routeImportMode === 'json' ? 'is-active' : ''}
                        onClick={() => setRouteImportMode('json')}
                        disabled={routeImporting}
                      >
                        JSON 檔案
                      </button>
                      <button
                        type="button"
                        className={routeImportMode === 'coordinates' ? 'is-active' : ''}
                        onClick={() => setRouteImportMode('coordinates')}
                        disabled={routeImporting}
                      >
                        貼上經緯度
                      </button>
                    </div>
                  </div>
                  {routeImportMode === 'json' && (
                    <p className="helper-text">支援先前匯出的種花路徑 JSON，路徑名稱可在上方覆蓋。</p>
                  )}
                </section>
                {routeImportMode === 'coordinates' && (
                  <section className="route-import-section route-import-coordinate-section">
                    <label className="field">
                      <span>經緯度資料</span>
                      <textarea
                        value={routeImportCoordinatesInput}
                        onChange={(e) => setRouteImportCoordinatesInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Escape') handleCloseRouteImportModal()
                        }}
                        placeholder={'22.355873,91.821189\n22.359052,91.822167'}
                        disabled={routeImporting}
                        rows={8}
                      />
                    </label>
                    <p className="helper-text">每行一個節點，格式為「緯度,經度」，至少需要 2 個路徑點。</p>
                  </section>
                )}
              </div>
              {routeImportMode === 'json' ? (
                <div className="modal-actions route-import-actions">
                  <button
                    className="ghost-button"
                    onClick={handleCloseRouteImportModal}
                    disabled={routeImporting}
                    type="button"
                  >
                    取消
                  </button>
                  <button
                    className="secondary-button"
                    onClick={() => routeImportInputRef.current?.click()}
                    disabled={routeImporting}
                    type="button"
                  >
                    {routeImporting ? '匯入中...' : '選擇 JSON 檔案'}
                  </button>
                </div>
              ) : (
                <div className="modal-actions route-import-actions">
                  <button
                    className="ghost-button"
                    onClick={handleCloseRouteImportModal}
                    disabled={routeImporting}
                    type="button"
                  >
                    取消
                  </button>
                  <button
                    className="primary-button"
                    onClick={() => void handleConfirmImportCoordinates()}
                    disabled={routeImporting || !routeImportCoordinatesInput.trim()}
                    type="button"
                  >
                    {routeImporting ? '匯入中...' : '確認匯入'}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {isRouteLibraryOpen && (
        <div className="modal-backdrop" onClick={() => setIsRouteLibraryOpen(false)}>
          <div className="modal-panel route-library-panel" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header route-library-header">
              <div>
                <p className="panel-kicker">已儲存路徑</p>
                <h3>讀取路徑</h3>
              </div>
              <span className="route-count-pill">{savedRoutes.length} 筆</span>
            </div>
            <div className="modal-body">
              {savedRoutes.length === 0 ? (
                <p className="route-empty">還沒有儲存路徑，先儲存目前路徑或匯入路徑檔案。</p>
              ) : (
                <div className="saved-route-list route-library-list">
                  {savedRoutes.map((route) => (
                    <div key={route.id} className="saved-route-item">
                      <button
                        className="saved-route-main"
                        onClick={() => handleLoadSavedRoute(route)}
                        disabled={routeStatus.state !== 'idle'}
                        type="button"
                      >
                        <span className="route-title-line">
                          <strong>{route.name}</strong>
                          <span className="route-distance-badge">{formatRouteDistance(route.waypoints)}</span>
                        </span>
                        <span>{route.waypoints.length} 個路徑點</span>
                      </button>
                      <div className="saved-route-actions">
                        <button
                          className="icon-button"
                          onClick={() => void handleCopyRouteCoordinates(route)}
                          aria-label={`複製路徑節點：${route.name}`}
                          title={`複製路徑節點：${route.name}`}
                          type="button"
                        >
                          <Copy aria-hidden="true" size={16} strokeWidth={2.4} />
                        </button>
                        <button
                          className="icon-button"
                          onClick={() => handleLoadSavedRoute(route)}
                          disabled={routeStatus.state !== 'idle'}
                          aria-label={`載入路徑：${route.name}`}
                          title={`載入路徑：${route.name}`}
                          type="button"
                        >
                          <FolderOpen aria-hidden="true" size={16} strokeWidth={2.4} />
                        </button>
                        <button
                          className="icon-button"
                          onClick={() => handleExportSavedRoute(route)}
                          aria-label={`匯出路徑：${route.name}`}
                          title={`匯出路徑：${route.name}`}
                          type="button"
                        >
                          <Download aria-hidden="true" size={16} strokeWidth={2.4} />
                        </button>
                        <button
                          className="icon-button danger"
                          onClick={() => void handleDeleteSavedRoute(route.id)}
                          aria-label={`刪除路徑：${route.name}`}
                          title={`刪除路徑：${route.name}`}
                          type="button"
                        >
                          <Trash2 aria-hidden="true" size={16} strokeWidth={2.4} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {isFlySettingsOpen && (
        <div className="modal-backdrop" onClick={() => setIsFlySettingsOpen(false)}>
          <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header"><h3>飛行設定</h3></div>
            <div className="modal-body modal-body-split fly-settings-layout">
              <section className="modal-section">
                <div className="field">
                  <span>輸入方式</span>
                  <div className="segmented-control" role="tablist" aria-label="飛行輸入方式">
                    <button type="button" className={flyMode === 'coordinate' ? 'is-active' : ''} onClick={() => handleSwitchFlyMode('coordinate')}>座標輸入</button>
                    <button type="button" className={flyMode === 'landmark' ? 'is-active' : ''} onClick={() => handleSwitchFlyMode('landmark')}>已儲存地標</button>
                  </div>
                </div>
                <label className="field">
                  <span>目的地</span>
                  <div className="field-inline flow-row">
                    {flyMode === 'coordinate' ? (
                      <input value={destinationInput} onChange={(e) => setDestinationInput(e.target.value)} placeholder="例如：25.033, 121.565" />
                    ) : (
                      <input value={destinationInput} onChange={(e) => setDestinationInput(e.target.value)} placeholder="從右側點選地標或輸入名稱" />
                    )}
                    <button className="accent-button" onClick={() => void handleFlyToDestination()} disabled={isFlying}>
                      {isFlying ? '執行中' : '飛行'}
                    </button>
                  </div>
                </label>
                <p className="helper-text">將飛往：{flyTargetText}</p>
              </section>
              {flyMode === 'landmark' && (
                <section className="modal-section landmark-browser">
                  <div className="landmark-toolbar">
                    <label className="field landmark-search-field">
                      <span>搜尋地標</span>
                      <input
                        value={flyLandmarkSearchInput}
                        onChange={(e) => setFlyLandmarkSearchInput(e.target.value)}
                        placeholder="輸入名稱或座標快速搜尋"
                      />
                    </label>
                    <div className="field">
                      <span>篩選</span>
                      <div className="segmented-control" role="tablist" aria-label="地標類型篩選">
                        <button
                          type="button"
                          className={flyLandmarkTypeFilter === 'all' ? 'is-active' : ''}
                          onClick={() => setFlyLandmarkTypeFilter('all')}
                        >
                          全部
                        </button>
                        <button
                          type="button"
                          className={flyLandmarkTypeFilter === 'flower' ? 'is-active' : ''}
                          onClick={() => setFlyLandmarkTypeFilter('flower')}
                        >
                          花點
                        </button>
                        <button
                          type="button"
                          className={flyLandmarkTypeFilter === 'mushroom' ? 'is-active' : ''}
                          onClick={() => setFlyLandmarkTypeFilter('mushroom')}
                        >
                          菇點
                        </button>
                      </div>
                    </div>
                  </div>
                  <div className="landmark-section-head">
                    <span>已新增地標</span>
                    <small>符合 {filteredFlyLandmarks.length} 筆，共 {savedLandmarks.length} 筆</small>
                  </div>
                  {savedLandmarks.length === 0 ? (
                    <p className="landmark-empty">目前還沒有地標，先到「地標管理」新增一筆。</p>
                  ) : filteredFlyLandmarks.length === 0 ? (
                    <p className="landmark-empty">找不到符合條件的地標，請調整搜尋關鍵字。</p>
                  ) : (
                    <>
                      <div className="landmark-edit-list fly-landmark-list">
                        {pagedFlyLandmarks.map((landmark) => (
                          <div key={landmark.id} className="landmark-edit-item fly-landmark-item">
                            <button className="landmark-edit-main" onClick={() => handleSelectLandmarkToFly(landmark.name)} type="button">
                              <span className={`landmark-type-dot is-${landmark.landmarkType}`} aria-hidden="true" />
                              <span className="landmark-row-copy">
                                <strong>{landmark.name}</strong>
                                <span>{formatCoordinate(landmark.coordinate)}</span>
                              </span>
                            </button>
                            <button
                              className="icon-button fly-landmark-delete"
                              onClick={() => void handleDeleteLandmark(landmark.id)}
                              aria-label={`刪除地標 ${landmark.name}`}
                              title={`刪除 ${landmark.name}`}
                              type="button"
                            >
                              <Trash2 aria-hidden="true" size={15} strokeWidth={2.4} />
                            </button>
                          </div>
                        ))}
                      </div>
                      {flyLandmarkPageCount > 1 && (
                        <div className="landmark-pagination" aria-label="飛行設定地標分頁">
                          <button
                            className="ghost-button"
                            type="button"
                            onClick={() => setFlyLandmarkPage((page) => Math.max(1, page - 1))}
                            disabled={safeFlyLandmarkPage <= 1}
                          >
                            上一頁
                          </button>
                          <span>第 {safeFlyLandmarkPage} / {flyLandmarkPageCount} 頁</span>
                          <button
                            className="ghost-button"
                            type="button"
                            onClick={() => setFlyLandmarkPage((page) => Math.min(flyLandmarkPageCount, page + 1))}
                            disabled={safeFlyLandmarkPage >= flyLandmarkPageCount}
                          >
                            下一頁
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </section>
              )}
            </div>
          </div>
        </div>
      )}

      {isLandmarkManagerOpen && (
        <div className="modal-backdrop" onClick={() => setIsLandmarkManagerOpen(false)}>
          <div className="modal-panel landmark-manager-panel" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header manager-modal-header">
              <div>
                <p className="manager-kicker">管理面板</p>
                <h3>地標 / 路徑管理</h3>
              </div>
              <button
                className="icon-button manager-close-button"
                onClick={() => setIsLandmarkManagerOpen(false)}
                aria-label="關閉地標與路徑管理"
                title="關閉"
                type="button"
              >
                <X aria-hidden="true" size={16} strokeWidth={2.4} />
              </button>
            </div>
            <div className="modal-body manager-workspace">
              <aside className="manager-sidebar" aria-label="管理類型">
                <div className="manager-sidebar-summary">
                  <span>目前檢視</span>
                  <strong>{managerTab === 'landmarks' ? '地標' : '路徑'}</strong>
                </div>
                <div className="manager-tabs" role="tablist" aria-label="管理類型">
                  <button
                    type="button"
                    className={managerTab === 'landmarks' ? 'is-active' : ''}
                    onClick={() => setManagerTab('landmarks')}
                  >
                    <span>地標</span>
                    <small>{savedLandmarks.length} 筆</small>
                  </button>
                  <button
                    type="button"
                    className={managerTab === 'routes' ? 'is-active' : ''}
                    onClick={() => setManagerTab('routes')}
                  >
                    <span>路徑</span>
                    <small>{savedRoutes.length} 筆</small>
                  </button>
                </div>
                <div className="manager-sidebar-note">
                  {managerTab === 'landmarks' ? '管理花點、菇點與常用目的地。' : '讀取、匯出或清理已儲存路徑。'}
                </div>
              </aside>
              <main className="manager-content">
                {managerTab === 'landmarks' ? (
                  <div className="manager-content-pane landmark-manager-layout">
                    <div className="manager-content-head">
                      <div>
                        <span>地標工具</span>
                        <strong>{landmarkManagerTab === 'create' ? '新增地標' : '搜尋地標'}</strong>
                      </div>
                      <div className="segmented-control landmark-subtabs" role="tablist" aria-label="地標管理功能">
                        <button
                          type="button"
                          className={landmarkManagerTab === 'create' ? 'is-active' : ''}
                          onClick={() => setLandmarkManagerTab('create')}
                        >
                          新增
                        </button>
                        <button
                          type="button"
                          className={landmarkManagerTab === 'search' ? 'is-active' : ''}
                          onClick={() => setLandmarkManagerTab('search')}
                        >
                          搜尋
                        </button>
                      </div>
                    </div>
                    {landmarkManagerTab === 'create' ? (
                  <section className="modal-section landmark-create-panel">
                    <div className="landmark-create-shell">
                      <div className="landmark-create-title">
                        <div>
                          <span>{editingLandmarkId ? '編輯模式' : '快速建立'}</span>
                          <strong>{editingLandmarkId ? '更新地標資訊' : '新增一個地圖標記'}</strong>
                        </div>
                        {editingLandmarkId && <p className="editing-hint">正在編輯已儲存地標</p>}
                      </div>
                      <div className="landmark-form-grid">
                        <label className="field">
                          <span>名稱</span>
                          <input
                            value={landmarkNameInput}
                            onChange={(e) => setLandmarkNameInput(e.target.value)}
                            onBlur={() => setLandmarkFormTouched(true)}
                            placeholder="例如：台北車站"
                            aria-invalid={Boolean(nameError)}
                          />
                          {nameError && <p className="helper-text helper-text--error">{nameError}</p>}
                        </label>
                        <label className="field">
                          <span>座標</span>
                          <input
                            value={landmarkCoordInput}
                            onChange={(e) => setLandmarkCoordInput(e.target.value)}
                            onBlur={() => setLandmarkFormTouched(true)}
                            placeholder="25.047924, 121.517081"
                            aria-invalid={Boolean(coordError)}
                          />
                          {coordError && <p className="helper-text helper-text--error">{coordError}</p>}
                        </label>
                      </div>
                      <div className="landmark-type-row">
                        <span className="landmark-type-label">類型</span>
                        <div className="landmark-type-options" role="radiogroup" aria-label="地標類型">
                          <button
                            type="button"
                            className={`landmark-type-pill is-mushroom${landmarkTypeInput === 'mushroom' ? ' is-active' : ''}`}
                            onClick={() => setLandmarkTypeInput('mushroom')}
                            role="radio"
                            aria-checked={landmarkTypeInput === 'mushroom'}
                          >
                            <span className="landmark-type-dot" aria-hidden="true" />
                            <span>
                              <strong>菇點</strong>
                            </span>
                          </button>
                          <button
                            type="button"
                            className={`landmark-type-pill is-flower${landmarkTypeInput === 'flower' ? ' is-active' : ''}`}
                            onClick={() => setLandmarkTypeInput('flower')}
                            role="radio"
                            aria-checked={landmarkTypeInput === 'flower'}
                          >
                            <span className="landmark-type-dot" aria-hidden="true" />
                            <span>
                              <strong>花點</strong>
                            </span>
                          </button>
                          <button
                            type="button"
                            className={`landmark-type-pill is-postcard${landmarkTypeInput === 'postcard' ? ' is-active' : ''}`}
                            onClick={() => setLandmarkTypeInput('postcard')}
                            role="radio"
                            aria-checked={landmarkTypeInput === 'postcard'}
                          >
                            <span className="landmark-type-dot" aria-hidden="true" style={{ background: 'var(--accent)' }} />
                            <span>
                              <strong>明信片</strong>
                            </span>
                          </button>
                        </div>
                      </div>
                      <label className="field">
                        <span>地區分類</span>
                        <input
                          type="text"
                          className="text-input"
                          value={landmarkRegionInput}
                          onChange={(e) => setLandmarkRegionInput(e.target.value)}
                          placeholder="例如：台北、日本、Xpark"
                          list="region-options"
                        />
                        <datalist id="region-options">
                          {Array.from(new Set(savedLandmarks.map(l => l.region).filter(Boolean))).map(r => (
                            <option key={r} value={r} />
                          ))}
                        </datalist>
                      </label>
                      <div className="landmark-create-actions">
                        <div className="landmark-create-note">
                          {editingLandmarkId ? '更新後會同步搜尋清單。' : '儲存後可直接從地標清單帶入目的地。'}
                        </div>
                        <button
                          className="secondary-button landmark-import-button"
                          onClick={() => landmarkImportInputRef.current?.click()}
                          type="button"
                        >
                          <FileInput aria-hidden="true" size={16} strokeWidth={2.4} />
                          匯入 JSON
                        </button>
                        <button className="primary-button" onClick={() => void handleSaveLandmark()} disabled={!isLandmarkFormValid || landmarkSaving}>
                          {landmarkSaving ? (editingLandmarkId ? '更新中' : '儲存中') : (editingLandmarkId ? '更新地標' : '儲存地標')}
                        </button>
                      </div>
                    </div>
                    <input
                      ref={landmarkImportInputRef}
                      className="sr-only"
                      type="file"
                      accept="application/json,.json"
                      onChange={(e) => {
                        const file = e.target.files?.[0] ?? null
                        void handleImportLandmarkFile(file)
                        e.currentTarget.value = ''
                      }}
                    />
                    {editingLandmarkId && (
                      <button className="ghost-button modal-stack-button" onClick={handleCancelLandmarkEdit}>
                        取消編輯
                      </button>
                    )}
                  </section>
                    ) : (
                  <section className="modal-section landmark-manager-list-panel">
                    <div className="landmark-toolbar">
                      <label className="field landmark-search-field">
                        <span>搜尋地標</span>
                        <input
                          value={landmarkSearchInput}
                          onChange={(e) => setLandmarkSearchInput(e.target.value)}
                          placeholder="輸入名稱或座標"
                        />
                      </label>
                      <div className="field">
                        <span>篩選</span>
                        <div className="segmented-control" role="tablist" aria-label="地標管理類型篩選">
                          <button
                            type="button"
                            className={landmarkTypeFilter === 'all' ? 'is-active' : ''}
                            onClick={() => setLandmarkTypeFilter('all')}
                          >
                            全部
                          </button>
                          <button
                            type="button"
                            className={landmarkTypeFilter === 'flower' ? 'is-active' : ''}
                            onClick={() => setLandmarkTypeFilter('flower')}
                          >
                            花點
                          </button>
                          <button
                            type="button"
                            className={landmarkTypeFilter === 'mushroom' ? 'is-active' : ''}
                            onClick={() => setLandmarkTypeFilter('mushroom')}
                          >
                            菇點
                          </button>
                        </div>
                      </div>
                    </div>
                    <div className="landmark-section-head">
                      <span>已儲存地標</span>
                      <small>符合 {filteredLandmarks.length} 筆，共 {savedLandmarks.length} 筆</small>
                    </div>
                    {savedLandmarks.length === 0 ? (
                      <p className="landmark-empty">目前還沒有地標，先到新增地標分頁建立一筆。</p>
                    ) : filteredLandmarks.length === 0 ? (
                      <p className="landmark-empty">找不到符合條件的地標。</p>
                    ) : (
                      <>
                        <div className="landmark-edit-list">
                          {pagedLandmarks.map((landmark) => (
                            <div key={landmark.id} className={`landmark-edit-item${editingLandmarkId === landmark.id ? ' is-editing' : ''}`}>
                              <button className="landmark-edit-main" onClick={() => handleSelectLandmarkToFly(landmark.name)} type="button">
                                <span className={`landmark-type-dot is-${landmark.landmarkType}`} aria-hidden="true" />
                                <span className="landmark-row-copy">
                                  <strong>{landmark.name}</strong>
                                  <span>{formatCoordinate(landmark.coordinate)}</span>
                                </span>
                              </button>
                              <div className="landmark-edit-actions">
                                <button
                                  className="icon-button"
                                  onClick={() => setOpenLandmarkActionId((current) => current === landmark.id ? '' : landmark.id)}
                                  aria-label={`開啟地標選單：${landmark.name}`}
                                  aria-expanded={openLandmarkActionId === landmark.id}
                                  title={`地標選單：${landmark.name}`}
                                  type="button"
                                >
                                  <MoreHorizontal aria-hidden="true" size={16} strokeWidth={2.4} />
                                </button>
                                {openLandmarkActionId === landmark.id && (
                                  <div className="landmark-action-menu">
                                    <button
                                      type="button"
                                      onClick={() => {
                                        void handleCopyLandmarkCoordinate(landmark)
                                        setOpenLandmarkActionId('')
                                      }}
                                    >
                                      <Copy aria-hidden="true" size={15} strokeWidth={2.4} />
                                      複製座標
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => {
                                        handleExportLandmark(landmark)
                                        setOpenLandmarkActionId('')
                                      }}
                                    >
                                      <Download aria-hidden="true" size={15} strokeWidth={2.4} />
                                      匯出
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => {
                                        handleEditLandmark(landmark)
                                        setOpenLandmarkActionId('')
                                      }}
                                    >
                                      <Pencil aria-hidden="true" size={15} strokeWidth={2.4} />
                                      編輯
                                    </button>
                                    <button
                                      className="danger"
                                      type="button"
                                      onClick={() => {
                                        setOpenLandmarkActionId('')
                                        void handleDeleteLandmark(landmark.id)
                                      }}
                                    >
                                      <Trash2 aria-hidden="true" size={15} strokeWidth={2.4} />
                                      刪除
                                    </button>
                                  </div>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                        {landmarkPageCount > 1 && (
                          <div className="landmark-pagination" aria-label="地標分頁">
                            <button
                              className="ghost-button"
                              type="button"
                              onClick={() => setLandmarkPage((page) => Math.max(1, page - 1))}
                              disabled={safeLandmarkPage <= 1}
                            >
                              上一頁
                            </button>
                            <span>第 {safeLandmarkPage} / {landmarkPageCount} 頁</span>
                            <button
                              className="ghost-button"
                              type="button"
                              onClick={() => setLandmarkPage((page) => Math.min(landmarkPageCount, page + 1))}
                              disabled={safeLandmarkPage >= landmarkPageCount}
                            >
                              下一頁
                            </button>
                          </div>
                        )}
                      </>
                    )}
                  </section>
                    )}
                  </div>
                ) : (
                  <div className="manager-content-pane route-manager-body">
                <section className="modal-section landmark-manager-list-panel route-manager-panel">
                  <div className="manager-content-head">
                    <div>
                      <span>路徑工具</span>
                      <strong>已儲存路徑</strong>
                    </div>
                  </div>
                  <div className="route-manager-toolbar">
                    <label className="field route-search-field">
                      <span>搜尋路徑</span>
                      <input
                        value={routeSearchInput}
                        onChange={(e) => setRouteSearchInput(e.target.value)}
                        placeholder="輸入路徑標題"
                      />
                    </label>
                    <div className="field route-import-field">
                      <span aria-hidden="true">匯入</span>
                      <button
                        className="secondary-button route-manager-import-button"
                        onClick={handleOpenRouteImportFromManager}
                        aria-label="匯入路徑"
                        title="匯入路徑"
                        type="button"
                      >
                        <FileInput aria-hidden="true" size={16} strokeWidth={2.4} />
                        匯入
                      </button>
                    </div>
                  </div>
                  <div className="landmark-section-head">
                    <span>已儲存路徑</span>
                    <small>符合 {filteredSavedRoutes.length} 筆，共 {savedRoutes.length} 筆</small>
                  </div>
                  {savedRoutes.length === 0 ? (
                    <p className="route-empty route-manager-empty">還沒有儲存路徑，先在路徑模式儲存目前路徑，或匯入路徑 JSON 檔案。</p>
                  ) : filteredSavedRoutes.length === 0 ? (
                    <p className="route-empty route-manager-empty">找不到符合標題的路徑。</p>
                  ) : (
                    <>
                      <div className="saved-route-list route-manager-list">
                        {pagedSavedRoutes.map((route) => (
                          <div key={route.id} className="saved-route-item route-manager-pill">
                            <div className="saved-route-main route-manager-main">
                              <span className="route-title-line">
                                <strong>{route.name}</strong>
                                <span className="route-distance-badge">{formatRouteDistance(route.waypoints)}</span>
                              </span>
                              <span>{route.waypoints.length} 個路徑點</span>
                            </div>
                            <div className="saved-route-actions">
                              <button
                                className="icon-button"
                                onClick={() => setOpenRouteActionId((current) => current === route.id ? '' : route.id)}
                                aria-label={`開啟路徑選單：${route.name}`}
                                aria-expanded={openRouteActionId === route.id}
                                title={`路徑選單：${route.name}`}
                                type="button"
                              >
                                <MoreHorizontal aria-hidden="true" size={16} strokeWidth={2.4} />
                              </button>
                              {openRouteActionId === route.id && (
                                <div className="landmark-action-menu">
                                  <button
                                    type="button"
                                    onClick={() => {
                                      void handleCopyRouteCoordinates(route)
                                      setOpenRouteActionId('')
                                    }}
                                  >
                                    <Copy aria-hidden="true" size={15} strokeWidth={2.4} />
                                    複製節點
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      handleExportSavedRoute(route)
                                      setOpenRouteActionId('')
                                    }}
                                  >
                                    <Download aria-hidden="true" size={15} strokeWidth={2.4} />
                                    匯出
                                  </button>
                                  <button
                                    className="danger"
                                    type="button"
                                    onClick={() => {
                                      setOpenRouteActionId('')
                                      void handleDeleteSavedRoute(route.id)
                                    }}
                                  >
                                    <Trash2 aria-hidden="true" size={15} strokeWidth={2.4} />
                                    刪除
                                  </button>
                                </div>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                      {routePageCount > 1 && (
                        <div className="landmark-pagination" aria-label="路徑分頁">
                          <button
                            className="ghost-button"
                            type="button"
                            onClick={() => setRoutePage((page) => Math.max(1, page - 1))}
                            disabled={safeRoutePage <= 1}
                          >
                            上一頁
                          </button>
                          <span>第 {safeRoutePage} / {routePageCount} 頁</span>
                          <button
                            className="ghost-button"
                            type="button"
                            onClick={() => setRoutePage((page) => Math.min(routePageCount, page + 1))}
                            disabled={safeRoutePage >= routePageCount}
                          >
                            下一頁
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </section>
                  </div>
                )}
              </main>
            </div>
          </div>
        </div>
      )}


    </div>
  )
}
