import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Church, Compass, Copy, Download, FileInput, FolderOpen, Layers3, Loader2, Mail, Map, MoreHorizontal, Pencil, Radar, Save, Search, Trees, Trash2, X, Zap } from 'lucide-react'
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
  region?: unknown
  tags?: unknown
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
  tags: string[]
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
  const rawTags = payload.tags
  const tags = Array.isArray(rawTags) ? rawTags.map((t: unknown) => String(t).trim()).filter(Boolean) : []
  return {
    name,
    coordinate: payload.coordinate,
    landmarkType: payload.landmarkType,
    region: typeof payload.region === 'string' ? payload.region : '未分類',
    tags,
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
  const [zoom, setZoom] = useState(16)
  const [singleModeOption, setSingleModeOption] = useState<'click' | 'coordinate'>('click')
  const [coordinateInput, setCoordinateInput] = useState('')
  const [isFilterOpen, setIsFilterOpen] = useState(false)
  const [selectedSavedRouteId, setSelectedSavedRouteId] = useState('')
  const [isMapClickArmed, setIsMapClickArmed] = useState(true) // Default to true so clicking works directly!
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
  const [landmarkTags, setLandmarkTags] = useState<string[]>([])
  const [landmarkNewTag, setLandmarkNewTag] = useState('')
  const [isAdvancedSearchOpen, setIsAdvancedSearchOpen] = useState(false)
  const [advancedSearchTab, setAdvancedSearchTab] = useState<'region' | 'type' | 'tag'>('region')
  const [selectedRegions, setSelectedRegions] = useState<string[]>([])
  const [selectedTypes, setSelectedTypes] = useState<string[]>([])
  const [selectedTags, setSelectedTags] = useState<string[]>([])
  const [openLandmarkActionId, setOpenLandmarkActionId] = useState('')
  const [savedRoutes, setSavedRoutes] = useState<SavedRoute[]>([])
  const [routeSaving, setRouteSaving] = useState(false)
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
  const [isTempImportModalOpen, setIsTempImportModalOpen] = useState(false)
  const [tempCoordsInput, setTempCoordsInput] = useState('')
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
    reverseRoute,
    syncCurrentPosition,
  } = useRoute(selectedDevice?.id ?? null, myPosition, handleRouteError)
  const isPlanting = routeStatus.state === 'moving'

  useEffect(() => {
    if (!isPlanting) return

    setIsMapClickArmed(false)
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

  const handleCoordinateFly = useCallback(() => {
    const parts = coordinateInput.split(/[\s,]+/).map(Number)
    if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
      const [lat, lng] = parts
      if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
        void handleFlyTo(lat, lng)
      } else {
        showToast('座標數值超出有效範圍 (緯度-90~90, 經度-180~180)')
      }
    } else {
      showToast('格式錯誤，請使用「緯度,經度」，例如：25.0478,121.5170')
    }
  }, [coordinateInput, handleFlyTo, showToast])

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

    if (optimized.length > 0) {
      void handleFlyTo(optimized[0].latitude, optimized[0].longitude)
    }
  }, [handleFlyTo, replaceWaypoints, routeStatus.state, showToast, waypoints])

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
        const updated = await apiClient.updateLandmark(editingLandmarkId, {
          name,
          coordinate: target,
          landmarkType: landmarkTypeInput,
          region: landmarkRegionInput,
          tags: landmarkTags,
        })
        setSavedLandmarks((prev) => prev.map((landmark) => landmark.id === updated.id ? updated : landmark))
        if (selectedLandmarkId === updated.id) {
          setDestinationInput(updated.name)
        }
        showToast('地標已更新')
      } else {
        const created = await apiClient.createLandmark({
          name,
          coordinate: target,
          landmarkType: landmarkTypeInput,
          region: landmarkRegionInput,
          tags: landmarkTags,
        })
        setSavedLandmarks((prev) => [created, ...prev])
        showToast('地標已儲存')
      }
      setLandmarkNameInput('')
      setLandmarkCoordInput('')
      setLandmarkTypeInput('mushroom')
      setLandmarkRegionInput('未分類')
      setLandmarkTags([])
      setLandmarkNewTag('')
      setEditingLandmarkId('')
      setLandmarkFormTouched(false)
    } catch (err) {
      showToast(err instanceof Error ? err.message : editingLandmarkId ? '更新地標失敗' : '儲存地標失敗')
    } finally {
      setLandmarkSaving(false)
    }
  }, [editingLandmarkId, landmarkCoordInput, landmarkNameInput, landmarkTypeInput, landmarkRegionInput, landmarkTags, selectedLandmarkId, showToast])

  const handleEditLandmark = useCallback((landmark: SavedLandmark) => {
    setEditingLandmarkId(landmark.id)
    setLandmarkManagerTab('create')
    setLandmarkNameInput(landmark.name)
    setLandmarkCoordInput(formatCoordinate(landmark.coordinate))
    setLandmarkTypeInput(landmark.landmarkType)
    setLandmarkRegionInput(landmark.region || '未分類')
    setLandmarkTags(landmark.tags || [])
    setLandmarkFormTouched(false)
  }, [])

  const handleCancelLandmarkEdit = useCallback(() => {
    setEditingLandmarkId('')
    setLandmarkNameInput('')
    setLandmarkCoordInput('')
    setLandmarkTypeInput('mushroom')
    setLandmarkRegionInput('未分類')
    setLandmarkTags([])
    setLandmarkNewTag('')
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
      region: landmark.region,
      tags: landmark.tags,
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
        tags: [],
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

  const handleConfirmTempImport = useCallback(() => {
    const trimmed = tempCoordsInput.trim()
    if (!trimmed) return

    let parsed: GPSCoordinate[] = []
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      try {
        const parsedJson = JSON.parse(trimmed)
        if (Array.isArray(parsedJson) && parsedJson.every(item => typeof item === 'object' && item && 'latitude' in item && 'longitude' in item)) {
          parsed = parsedJson.map((item: any) => ({
            latitude: Number(item.latitude),
            longitude: Number(item.longitude)
          }))
        } else {
          throw new Error('JSON 格式錯誤，必須是包含 latitude 和 longitude 屬性的陣列')
        }
      } catch (err) {
        showToast(err instanceof Error ? err.message : 'JSON 解析失敗')
        return
      }
    } else {
      try {
        parsed = parseRouteCoordinateLines(trimmed)
      } catch (err) {
        showToast(err instanceof Error ? err.message : '座標解析失敗')
        return
      }
    }

    if (parsed.length > 0) {
      replaceWaypoints(parsed)
      setViewTarget({ ...parsed[0] })
      setSelectedSavedRouteId('') // Clear selected saved route because this is a temp route
      setIsTempImportModalOpen(false)
      setTempCoordsInput('')
      setHasGeneratedFlowerRoute(false)
      setGeneratedRouteSummary(null)
      showToast('暫存路徑匯入成功，地圖已聚焦至起點。您可以點擊「最佳路線」進行優化後開始移動！')
    }
  }, [tempCoordsInput, replaceWaypoints, showToast])

  const handleReverseRoute = useCallback(async () => {
    try {
      await reverseRoute()
      setHasGeneratedFlowerRoute(false)
      setGeneratedRouteSummary(null)
      showToast('路徑已反轉')
    } catch (err) {
      showToast(err instanceof Error ? err.message : '反轉路徑失敗')
    }
  }, [reverseRoute, showToast])

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
    const quickTypeMatched = landmarkTypeFilter === 'all' || landmark.landmarkType === (landmarkTypeFilter === 'postcard' ? 'postcard' : landmarkTypeFilter)
    const typeMatched = selectedTypes.length === 0 || selectedTypes.includes(landmark.landmarkType)
    const regionMatched = selectedRegions.length === 0 || selectedRegions.includes(landmark.region)
    const tagMatched = selectedTags.length === 0 || (landmark.tags && landmark.tags.some(t => selectedTags.includes(t)))

    if (!quickTypeMatched || !typeMatched || !regionMatched || !tagMatched) return false

    if (!normalizedSearchKeyword) return true
    const nameMatched = landmark.name.toLowerCase().includes(normalizedSearchKeyword)
    const coordText = formatCoordinate(landmark.coordinate).toLowerCase()
    const coordMatched = coordText.includes(normalizedSearchKeyword)
    const tagsText = (landmark.tags || []).join(' ').toLowerCase()
    const tagKeywordMatched = tagsText.includes(normalizedSearchKeyword)
    return nameMatched || coordMatched || tagKeywordMatched
  })
  const landmarkPageCount = Math.max(1, Math.ceil(filteredLandmarks.length / LANDMARKS_PER_PAGE))
  const safeLandmarkPage = Math.min(landmarkPage, landmarkPageCount)
  const pagedLandmarks = filteredLandmarks.slice(
    (safeLandmarkPage - 1) * LANDMARKS_PER_PAGE,
    safeLandmarkPage * LANDMARKS_PER_PAGE,
  )
  const normalizedFlyLandmarkSearchKeyword = flyLandmarkSearchInput.trim().toLowerCase()
  const filteredFlyLandmarks = savedLandmarks.filter((landmark) => {
    const quickTypeMatched = flyLandmarkTypeFilter === 'all' || landmark.landmarkType === (flyLandmarkTypeFilter === 'postcard' ? 'postcard' : flyLandmarkTypeFilter)
    const typeMatched = selectedTypes.length === 0 || selectedTypes.includes(landmark.landmarkType)
    const regionMatched = selectedRegions.length === 0 || selectedRegions.includes(landmark.region)
    const tagMatched = selectedTags.length === 0 || (landmark.tags && landmark.tags.some(t => selectedTags.includes(t)))

    if (!quickTypeMatched || !typeMatched || !regionMatched || !tagMatched) return false

    if (!normalizedFlyLandmarkSearchKeyword) return true
    const nameMatched = landmark.name.toLowerCase().includes(normalizedFlyLandmarkSearchKeyword)
    const coordText = formatCoordinate(landmark.coordinate).toLowerCase()
    const coordMatched = coordText.includes(normalizedFlyLandmarkSearchKeyword)
    const tagsText = (landmark.tags || []).join(' ').toLowerCase()
    const tagKeywordMatched = tagsText.includes(normalizedFlyLandmarkSearchKeyword)
    return nameMatched || coordMatched || tagKeywordMatched
  })
  const flyLandmarkPageCount = Math.max(1, Math.ceil(filteredFlyLandmarks.length / LANDMARKS_PER_PAGE))
  const safeFlyLandmarkPage = Math.min(flyLandmarkPage, flyLandmarkPageCount)
  const pagedFlyLandmarks = filteredFlyLandmarks.slice(
    (safeFlyLandmarkPage - 1) * LANDMARKS_PER_PAGE,
    safeFlyLandmarkPage * LANDMARKS_PER_PAGE,
  )
  const filteredSidebarLandmarks = savedLandmarks.filter((landmark) => {
    const typeMatched = selectedTypes.length === 0 || selectedTypes.includes(landmark.landmarkType)
    const regionMatched = selectedRegions.length === 0 || selectedRegions.includes(landmark.region)
    const tagMatched = selectedTags.length === 0 || (landmark.tags && landmark.tags.some(t => selectedTags.includes(t)))
    return typeMatched && regionMatched && tagMatched
  })
  const activeFilterCount = selectedRegions.length + selectedTypes.length + selectedTags.length
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
          zoom={zoom}
          onZoomChange={setZoom}
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
            <div className="sidebar-top-controls">
              <button
                type="button"
                className="locate-refresh-btn"
                onClick={locateByBrowser}
                disabled={isLocating}
                title="重新取得定位"
              >
                {isLocating ? <Loader2 size={15} className="spinner" /> : <Compass size={15} />}
                <span>重新取得目前位置</span>
              </button>
            </div>

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

              <label className="field">
                <span>操作模式</span>
                <div className="mode-control-row">
                  <select
                    value={mode}
                    onChange={(e) => {
                      const newMode = e.target.value as Mode
                      setMode(newMode)
                      if (newMode === 'route') {
                        setIsMapClickArmed(true)
                        if (waypoints.length > 0) {
                          setViewTarget({ ...waypoints[0] })
                        }
                      } else {
                        setIsMapClickArmed(true)
                      }
                    }}
                    aria-label="操作模式"
                  >
                    <option value="single">單點定位</option>
                    <option value="route">路徑模式</option>
                  </select>
                  <div className="mode-field-actions">
                    <button
                      className="icon-button mode-action-button"
                      onClick={() => {
                        setManagerTab('landmarks')
                        setIsLandmarkManagerOpen(true)
                      }}
                      aria-label="地標 / 路徑管理"
                      title="地標 / 路徑管理"
                      disabled={isPlanting}
                      type="button"
                    >
                      <FolderOpen aria-hidden="true" size={16} strokeWidth={2.4} />
                    </button>
                    <button
                      className="icon-button mode-action-button"
                      onClick={() => setIsFlySettingsOpen(true)}
                      aria-label="飛行設定"
                      title="飛行設定"
                      disabled={isPlanting}
                      type="button"
                    >
                      <Map aria-hidden="true" size={16} strokeWidth={2.4} />
                    </button>
                  </div>
                </div>
              </label>

              {mode === 'single' && (
                <div className="single-mode-selector">
                  <div className="tab-group">
                    <button
                      type="button"
                      className={`tab-btn${singleModeOption === 'click' ? ' is-active' : ''}`}
                      onClick={() => {
                        setSingleModeOption('click')
                        setIsMapClickArmed(true)
                      }}
                    >
                      單點定位
                    </button>
                    <button
                      type="button"
                      className={`tab-btn${singleModeOption === 'coordinate' ? ' is-active' : ''}`}
                      onClick={() => {
                        setSingleModeOption('coordinate')
                        setIsMapClickArmed(false)
                      }}
                    >
                      輸入座標
                    </button>
                  </div>
                  
                  {singleModeOption === 'coordinate' && (
                    <div className="coordinate-fly-wrapper">
                      <input
                        type="text"
                        className="text-input"
                        placeholder="緯度,經度 (如: 25.04, 121.51)"
                        value={coordinateInput}
                        onChange={(e) => setCoordinateInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleCoordinateFly()
                        }}
                      />
                      <button
                        type="button"
                        className="primary-button"
                        onClick={handleCoordinateFly}
                      >
                        飛行
                      </button>
                    </div>
                  )}
                </div>
              )}

              {mode === 'single' && (
                <div className="single-mode-landmark-select-group" style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '10px', padding: '10px', background: 'var(--surface-hover)', borderRadius: '8px', border: '1px solid var(--border-medium)', boxSizing: 'border-box' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-secondary)' }}>選擇已存地標</span>
                    <button
                      type="button"
                      className={`advanced-filter-toggle-btn${activeFilterCount > 0 ? ' is-active' : ''}`}
                      onClick={() => {
                        setAdvancedSearchTab('region')
                        setIsAdvancedSearchOpen(true)
                      }}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '4px',
                        height: '26px',
                        padding: '0 8px',
                        borderRadius: '4px',
                        border: '1px solid var(--border-medium)',
                        background: activeFilterCount > 0 ? '#ffeeb3' : 'var(--surface-elevated)',
                        color: activeFilterCount > 0 ? '#856404' : 'var(--text-secondary)',
                        fontSize: '11px',
                        fontWeight: 600,
                        cursor: 'pointer',
                      }}
                    >
                      <span>進階篩選</span>
                      {activeFilterCount > 0 && (
                        <span style={{
                          background: '#ffc107',
                          color: '#212529',
                          borderRadius: '50%',
                          width: '14px',
                          height: '14px',
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontSize: '9px',
                          fontWeight: 800,
                        }}>
                          {activeFilterCount}
                        </span>
                      )}
                    </button>
                  </div>
                  <select
                    value={selectedLandmarkId}
                    onChange={(e) => {
                      const id = e.target.value
                      setSelectedLandmarkId(id)
                      const landmark = savedLandmarks.find((l) => l.id === id)
                      if (landmark) {
                        void handleFlyTo(landmark.coordinate.latitude, landmark.coordinate.longitude)
                      }
                    }}
                    style={{
                      width: '100%',
                      height: '36px',
                      borderRadius: '6px',
                      border: '1px solid var(--border-medium)',
                      background: 'var(--surface-elevated)',
                      color: 'var(--text-primary)',
                      padding: '0 8px',
                      fontSize: '13px',
                    }}
                    disabled={isPlanting}
                  >
                    <option value="">-- 選擇地標 (符合 {filteredSidebarLandmarks.length} 筆) --</option>
                    {filteredSidebarLandmarks.map((landmark) => (
                      <option key={landmark.id} value={landmark.id}>
                        {landmark.name} ({landmark.landmarkType === 'flower' ? '花' : landmark.landmarkType === 'mushroom' ? '菇' : '明信片'}{landmark.region !== '未分類' ? ` - ${landmark.region}` : ''})
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <LocationSearch
                onLocationSelect={handleFlyTo}
                disabled={isPlanting}
              />

              <div className="filter-section">
                <button
                  type="button"
                  className={`filter-toggle-btn${isFilterOpen ? ' is-open' : ''}`}
                  onClick={() => setIsFilterOpen(!isFilterOpen)}
                >
                  <Layers3 size={15} strokeWidth={2.4} />
                  <span>篩選項目</span>
                  <span className="arrow">{isFilterOpen ? '▲' : '▼'}</span>
                </button>
                {isFilterOpen && (
                  <div className="filter-expanded-panel">
                    <div className="filter-group">
                      <span className="filter-label">地圖圖層顯示</span>
                      <div className="filter-button-group">
                        <button
                          type="button"
                          className={`filter-btn${mapLayerFilter.flower ? ' is-active' : ''}`}
                          onClick={() => setMapLayerFilter(prev => ({ ...prev, flower: !prev.flower }))}
                        >
                          花點
                        </button>
                        <button
                          type="button"
                          className={`filter-btn${mapLayerFilter.mushroom ? ' is-active' : ''}`}
                          onClick={() => setMapLayerFilter(prev => ({ ...prev, mushroom: !prev.mushroom }))}
                        >
                          菇點
                        </button>
                        <button
                          type="button"
                          className={`filter-btn${mapLayerFilter.postcard ? ' is-active' : ''}`}
                          onClick={() => setMapLayerFilter(prev => ({ ...prev, postcard: !prev.postcard }))}
                        >
                          明信片
                        </button>
                      </div>
                    </div>
                    <div className="filter-group">
                      <span className="filter-label">地區篩選</span>
                      <select
                        value={mapLayerFilter.region}
                        onChange={(e) => setMapLayerFilter(prev => ({ ...prev, region: e.target.value }))}
                      >
                        <option value="all">所有地區</option>
                        {Array.from(new Set(savedLandmarks.map(l => l.region).filter(Boolean))).map(r => (
                          <option key={r} value={r}>{r}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                )}
              </div>

              <p className="helper-text" aria-live="polite">
                {isPlanting
                  ? '種花中已鎖定點圖操作與位置設定，停止後可重新調整'
                  : mode === 'single'
                    ? singleModeOption === 'click'
                      ? '點擊地圖任何位置直接更新虛擬定位'
                      : '請在上方輸入座標並點擊飛行'
                    : '點擊地圖加入路徑點'}
              </p>

              {mode === 'route' && (
                <div className="route-mode-selectors">
                  <label className="field">
                    <span>選擇已存路徑</span>
                    <select
                      value={selectedSavedRouteId}
                      onChange={(e) => {
                        const id = e.target.value
                        setSelectedSavedRouteId(id)
                        const route = savedRoutes.find((r) => r.id === id)
                        if (route) {
                          replaceWaypoints(route.waypoints)
                          if (route.waypoints.length > 0) {
                            setViewTarget({ ...route.waypoints[0] })
                          }
                          showToast(`已載入路徑: ${route.name}`)
                        }
                      }}
                    >
                      <option value="">-- 新增/載入路徑 --</option>
                      {savedRoutes.map((route) => (
                        <option key={route.id} value={route.id}>
                          {route.name} ({route.waypoints.length}點)
                        </option>
                      ))}
                    </select>
                  </label>
                  <div style={{ marginTop: '8px' }}>
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => setIsTempImportModalOpen(true)}
                      style={{ width: '100%', height: '36px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}
                      disabled={isPlanting}
                    >
                      <FileInput size={14} />
                      <span>匯入暫存座標</span>
                    </button>
                  </div>
                </div>
              )}

              {mode === 'route' && (
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
                    onReverseRoute={handleReverseRoute}
                  />
                </div>
              )}
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

      {isTempImportModalOpen && (
        <div className="modal-backdrop" onClick={() => setIsTempImportModalOpen(false)}>
          <div className="modal-panel modal-panel-narrow" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>匯入暫存座標</h3>
            </div>
            <div className="modal-body">
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <p className="helper-text" style={{ fontSize: '13px', margin: 0, color: 'var(--text-muted)' }}>
                  請貼上經緯度座標（每行一筆，例如：`25.04, 121.51`）或 JSON 座標陣列。此路徑為暫時使用，不會儲存至路徑庫。
                </p>
                <textarea
                  className="text-input"
                  placeholder="25.0478, 121.5170&#10;25.0485, 121.5185&#10;..."
                  value={tempCoordsInput}
                  onChange={(e) => setTempCoordsInput(e.target.value)}
                  style={{ height: '180px', width: '100%', resize: 'vertical', fontSize: '13px', fontFamily: 'monospace', padding: '10px', background: 'var(--bg-card)', color: 'var(--text-primary)', border: '1px solid var(--border-medium)', borderRadius: '6px' }}
                />
                <div className="modal-footer" style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '8px' }}>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => {
                      setTempCoordsInput('')
                      setIsTempImportModalOpen(false)
                    }}
                    style={{ height: '36px', padding: '0 16px', fontSize: '13px' }}
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    className="primary-button"
                    onClick={handleConfirmTempImport}
                    disabled={!tempCoordsInput.trim()}
                    style={{ height: '36px', padding: '0 16px', fontSize: '13px' }}
                  >
                    匯入
                  </button>
                </div>
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
                        <div className="route-title-line">
                          <strong>{route.name}</strong>
                          <span className="route-distance-badge">{formatRouteDistance(route.waypoints)}</span>
                        </div>
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
                  <div className="landmark-toolbar" style={{ display: 'flex', flexWrap: 'wrap', gap: '12px', alignItems: 'center' }}>
                    <label className="field landmark-search-field" style={{ flex: '1 1 200px' }}>
                      <span>搜尋地標</span>
                      <input
                        value={flyLandmarkSearchInput}
                        onChange={(e) => setFlyLandmarkSearchInput(e.target.value)}
                        placeholder="輸入名稱或座標快速搜尋"
                      />
                    </label>
                    <div className="field" style={{ flex: '0 0 auto' }}>
                      <span>類型</span>
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
                        <button
                          type="button"
                          className={flyLandmarkTypeFilter === 'postcard' ? 'is-active' : ''}
                          onClick={() => setFlyLandmarkTypeFilter('postcard')}
                        >
                          探測器
                        </button>
                      </div>
                    </div>
                    <div className="field" style={{ flex: '0 0 auto', alignSelf: 'flex-end' }}>
                      <button
                        type="button"
                        className={`advanced-filter-toggle-btn${activeFilterCount > 0 ? ' is-active' : ''}`}
                        onClick={() => {
                          setAdvancedSearchTab('region')
                          setIsAdvancedSearchOpen(true)
                        }}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '6px',
                          height: '38px',
                          padding: '0 16px',
                          borderRadius: '8px',
                          border: '1px solid var(--border-medium)',
                          background: activeFilterCount > 0 ? '#ffeeb3' : 'var(--surface-elevated)',
                          color: activeFilterCount > 0 ? '#856404' : 'var(--text-primary)',
                          fontWeight: 600,
                          cursor: 'pointer',
                          transition: 'all 0.15s ease',
                        }}
                      >
                        <span>進階搜尋</span>
                        {activeFilterCount > 0 && (
                          <span style={{
                            background: '#ffc107',
                            color: '#212529',
                            borderRadius: '50%',
                            width: '18px',
                            height: '18px',
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontSize: '11px',
                            fontWeight: 800,
                            marginLeft: '4px',
                          }}>
                            {activeFilterCount}
                          </span>
                        )}
                      </button>
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
                                <span>{formatCoordinate(landmark.coordinate)}{landmark.region !== '未分類' ? ` | 分類: ${landmark.region}` : ''}</span>
                                {landmark.tags && landmark.tags.length > 0 && (
                                  <span className="landmark-row-tags" style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', marginTop: '4px' }}>
                                    {landmark.tags.map(t => (
                                      <span key={t} className="tag-pill" style={{ fontSize: '10px', background: 'var(--surface-hover)', padding: '2px 6px', borderRadius: '8px', border: '1px solid var(--border-medium)', color: 'var(--text-secondary)' }}>
                                        #{t}
                                      </span>
                                    ))}
                                  </span>
                                )}
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
                        <select
                          className="select-input"
                          style={{
                            width: '100%',
                            height: '38px',
                            borderRadius: '8px',
                            border: '1px solid var(--border-medium)',
                            background: 'var(--surface-elevated)',
                            color: 'var(--text-primary)',
                            padding: '0 10px',
                            fontSize: '14px',
                          }}
                          value={
                            ['亞洲', '歐洲', '美洲', '非洲', '大洋洲', '台灣', '日本', '韓國', '美國', '越南', '冰島', '未分類'].includes(landmarkRegionInput)
                              ? landmarkRegionInput
                              : '自訂'
                          }
                          onChange={(e) => {
                            const val = e.target.value
                            if (val !== '自訂') {
                              setLandmarkRegionInput(val)
                            } else {
                              setLandmarkRegionInput('')
                            }
                          }}
                        >
                          <option value="未分類">未分類</option>
                          <option value="亞洲">亞洲</option>
                          <option value="歐洲">歐洲</option>
                          <option value="美洲">美洲</option>
                          <option value="非洲">非洲</option>
                          <option value="大洋洲">大洋洲</option>
                          <option value="台灣">台灣</option>
                          <option value="日本">日本</option>
                          <option value="韓國">韓國</option>
                          <option value="美國">美國</option>
                          <option value="越南">越南</option>
                          <option value="冰島">冰島</option>
                          <option value="自訂">自訂地區名稱...</option>
                        </select>
                        {!['亞洲', '歐洲', '美洲', '非洲', '大洋洲', '台灣', '日本', '韓國', '美國', '越南', '冰島', '未分類'].includes(landmarkRegionInput) && (
                          <input
                            type="text"
                            className="text-input"
                            style={{ marginTop: '8px' }}
                            value={landmarkRegionInput}
                            onChange={(e) => setLandmarkRegionInput(e.target.value)}
                            placeholder="請輸入自訂地區名稱"
                          />
                        )}
                      </label>

                      <div className="field">
                        <span>地標標籤 (#)</span>
                        <div className="tag-input-container" style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
                          <input
                            type="text"
                            className="text-input"
                            placeholder="輸入標籤後點選新增 (如: 巨菇、景點)"
                            value={landmarkNewTag}
                            onChange={(e) => setLandmarkNewTag(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault()
                                const val = landmarkNewTag.trim().replace(/^#/, '')
                                if (val && !landmarkTags.includes(val)) {
                                  setLandmarkTags([...landmarkTags, val])
                                }
                                setLandmarkNewTag('')
                              }
                            }}
                          />
                          <button
                            type="button"
                            className="secondary-button"
                            style={{ minWidth: '60px', padding: '0 12px', height: '36px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                            onClick={() => {
                              const val = landmarkNewTag.trim().replace(/^#/, '')
                              if (val && !landmarkTags.includes(val)) {
                                  setLandmarkTags([...landmarkTags, val])
                              }
                              setLandmarkNewTag('')
                            }}
                          >
                            新增
                          </button>
                        </div>
                        {landmarkTags.length > 0 && (
                          <div className="landmark-tags-list" style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                            {landmarkTags.map((tag) => (
                              <span
                                key={tag}
                                className="landmark-tag-badge"
                                style={{
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: '4px',
                                  padding: '4px 8px',
                                  borderRadius: '12px',
                                  background: 'var(--surface-hover)',
                                  border: '1px solid var(--border-medium)',
                                  fontSize: '12px',
                                  fontWeight: 600,
                                }}
                              >
                                #{tag}
                                <button
                                  type="button"
                                  onClick={() => setLandmarkTags(landmarkTags.filter((t) => t !== tag))}
                                  style={{
                                    border: 'none',
                                    background: 'none',
                                    padding: 0,
                                    cursor: 'pointer',
                                    color: 'var(--text-secondary)',
                                    fontSize: '11px',
                                    fontWeight: 800,
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    width: '12px',
                                    height: '12px',
                                  }}
                                >
                                  ×
                                </button>
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
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
                    <div className="landmark-toolbar" style={{ display: 'flex', flexWrap: 'wrap', gap: '12px', alignItems: 'center' }}>
                      <label className="field landmark-search-field" style={{ flex: '1 1 200px' }}>
                        <span>搜尋地標</span>
                        <input
                          value={landmarkSearchInput}
                          onChange={(e) => setLandmarkSearchInput(e.target.value)}
                          placeholder="輸入名稱或座標"
                        />
                      </label>
                      <div className="field" style={{ flex: '0 0 auto' }}>
                        <span>類型</span>
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
                          <button
                            type="button"
                            className={landmarkTypeFilter === 'postcard' ? 'is-active' : ''}
                            onClick={() => setLandmarkTypeFilter('postcard')}
                          >
                            探測器
                          </button>
                        </div>
                      </div>
                      <div className="field" style={{ flex: '0 0 auto', alignSelf: 'flex-end' }}>
                        <button
                          type="button"
                          className={`advanced-filter-toggle-btn${activeFilterCount > 0 ? ' is-active' : ''}`}
                          onClick={() => {
                            setAdvancedSearchTab('region')
                            setIsAdvancedSearchOpen(true)
                          }}
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '6px',
                            height: '38px',
                            padding: '0 16px',
                            borderRadius: '8px',
                            border: '1px solid var(--border-medium)',
                            background: activeFilterCount > 0 ? '#ffeeb3' : 'var(--surface-elevated)',
                            color: activeFilterCount > 0 ? '#856404' : 'var(--text-primary)',
                            fontWeight: 600,
                            cursor: 'pointer',
                            transition: 'all 0.15s ease',
                          }}
                        >
                          <span>進階搜尋</span>
                          {activeFilterCount > 0 && (
                            <span style={{
                              background: '#ffc107',
                              color: '#212529',
                              borderRadius: '50%',
                              width: '18px',
                              height: '18px',
                              display: 'inline-flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              fontSize: '11px',
                              fontWeight: 800,
                              marginLeft: '4px',
                            }}>
                              {activeFilterCount}
                            </span>
                          )}
                        </button>
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
                                  <span>{formatCoordinate(landmark.coordinate)}{landmark.region !== '未分類' ? ` | 分類: ${landmark.region}` : ''}</span>
                                  {landmark.tags && landmark.tags.length > 0 && (
                                    <span className="landmark-row-tags" style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', marginTop: '4px' }}>
                                      {landmark.tags.map(t => (
                                        <span key={t} className="tag-pill" style={{ fontSize: '10px', background: 'var(--surface-hover)', padding: '2px 6px', borderRadius: '8px', border: '1px solid var(--border-medium)', color: 'var(--text-secondary)' }}>
                                          #{t}
                                        </span>
                                      ))}
                                    </span>
                                  )}
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
                              <div className="route-title-line">
                                <strong>{route.name}</strong>
                                <span className="route-distance-badge">{formatRouteDistance(route.waypoints)}</span>
                              </div>
                              <span>{route.waypoints.length} 個路徑點</span>
                            </div>
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
      {isAdvancedSearchOpen && (
        <div className="modal-backdrop" onClick={() => setIsAdvancedSearchOpen(false)}>
          <div className="modal-panel advanced-search-modal-panel" onClick={(e) => e.stopPropagation()} style={{
            maxWidth: '680px',
            width: '90%',
            maxHeight: '85vh',
            borderRadius: '24px',
            background: '#faf9f6',
            boxShadow: '0 20px 40px rgba(0,0,0,0.12)',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          }}>
            {/* Modal Header */}
            <div className="modal-header" style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '20px 24px 10px 24px',
              borderBottom: 'none',
              background: 'transparent',
            }}>
              <h3 style={{ margin: 0, fontSize: '20px', fontWeight: 800, color: 'var(--text-primary)' }}>進階搜尋</h3>
              <button
                type="button"
                className="icon-button"
                onClick={() => setIsAdvancedSearchOpen(false)}
                style={{ border: 'none', background: 'var(--surface-hover)', borderRadius: '50%', width: '30px', height: '30px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
              >
                <X size={16} strokeWidth={2.6} />
              </button>
            </div>

            {/* Active Filters Summary */}
            <div className="active-filters-summary" style={{ padding: '0 24px 16px 24px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                <span className={`summary-pill${advancedSearchTab === 'region' ? ' is-active' : ''}`} style={{
                  padding: '6px 14px',
                  borderRadius: '16px',
                  border: '1px solid var(--border-medium)',
                  fontSize: '12px',
                  fontWeight: 600,
                  background: selectedRegions.length > 0 ? '#fbeed5' : 'transparent',
                  color: selectedRegions.length > 0 ? '#b27a30' : 'var(--text-secondary)',
                }}>
                  地區 {selectedRegions.length > 0 && `(${selectedRegions.length})`}
                </span>
                <span className={`summary-pill${advancedSearchTab === 'type' ? ' is-active' : ''}`} style={{
                  padding: '6px 14px',
                  borderRadius: '16px',
                  border: '1px solid var(--border-medium)',
                  fontSize: '12px',
                  fontWeight: 600,
                  background: selectedTypes.length > 0 ? '#fbeed5' : 'transparent',
                  color: selectedTypes.length > 0 ? '#b27a30' : 'var(--text-secondary)',
                }}>
                  類別 {selectedTypes.length > 0 && `(${selectedTypes.length})`}
                </span>
                <span className={`summary-pill${advancedSearchTab === 'tag' ? ' is-active' : ''}`} style={{
                  padding: '6px 14px',
                  borderRadius: '16px',
                  border: '1px solid var(--border-medium)',
                  fontSize: '12px',
                  fontWeight: 600,
                  background: selectedTags.length > 0 ? '#fbeed5' : 'transparent',
                  color: selectedTags.length > 0 ? '#b27a30' : 'var(--text-secondary)',
                }}>
                  標籤 {selectedTags.length > 0 && `(${selectedTags.length})`}
                </span>
              </div>

              {/* Selected items chips */}
              <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', minHeight: '24px', alignItems: 'center' }}>
                {selectedRegions.map(r => (
                  <span key={r} style={{ padding: '4px 10px', borderRadius: '12px', background: '#eef2ff', color: '#4f46e5', fontSize: '11px', fontWeight: 600 }}>
                    {r}
                  </span>
                ))}
                {selectedTypes.map(t => (
                  <span key={t} style={{ padding: '4px 10px', borderRadius: '12px', background: '#eef2ff', color: '#4f46e5', fontSize: '11px', fontWeight: 600 }}>
                    {t === 'flower' ? '花點' : t === 'mushroom' ? '菇點' : '探測器'}
                  </span>
                ))}
                {selectedTags.map(t => (
                  <span key={t} style={{ padding: '4px 10px', borderRadius: '12px', background: '#eef2ff', color: '#4f46e5', fontSize: '11px', fontWeight: 600 }}>
                    #{t}
                  </span>
                ))}
              </div>
            </div>

            {/* Split Content Body */}
            <div className="modal-body" style={{
              flex: 1,
              display: 'flex',
              padding: '0 24px',
              gap: '20px',
              overflow: 'hidden',
              minHeight: '280px',
            }}>
              {/* Left Menu Sidebar */}
              <div className="advanced-search-menu" style={{ width: '180px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                <button
                  type="button"
                  onClick={() => setAdvancedSearchTab('region')}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'flex-start',
                    padding: '12px 16px',
                    borderRadius: '16px',
                    border: '1px solid var(--border-medium)',
                    background: advancedSearchTab === 'region' ? 'var(--surface-elevated)' : 'transparent',
                    boxShadow: advancedSearchTab === 'region' ? '0 4px 10px rgba(0,0,0,0.04)' : 'none',
                    textAlign: 'left',
                    cursor: 'pointer',
                    width: '100%',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%', alignItems: 'center' }}>
                    <span style={{ fontWeight: 700, fontSize: '14px', color: 'var(--text-primary)' }}>地區</span>
                    {selectedRegions.length > 0 && (
                      <span style={{ background: '#34c759', color: '#fff', borderRadius: '50%', width: '18px', height: '18px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '10px', fontWeight: 800 }}>{selectedRegions.length}</span>
                    )}
                  </div>
                  <span style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '4px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', width: '100%' }}>
                    {selectedRegions.length > 0 ? selectedRegions.join('、') : '全部地區'}
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() => setAdvancedSearchTab('type')}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'flex-start',
                    padding: '12px 16px',
                    borderRadius: '16px',
                    border: '1px solid var(--border-medium)',
                    background: advancedSearchTab === 'type' ? 'var(--surface-elevated)' : 'transparent',
                    boxShadow: advancedSearchTab === 'type' ? '0 4px 10px rgba(0,0,0,0.04)' : 'none',
                    textAlign: 'left',
                    cursor: 'pointer',
                    width: '100%',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%', alignItems: 'center' }}>
                    <span style={{ fontWeight: 700, fontSize: '14px', color: 'var(--text-primary)' }}>類別</span>
                    {selectedTypes.length > 0 && (
                      <span style={{ background: '#34c759', color: '#fff', borderRadius: '50%', width: '18px', height: '18px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '10px', fontWeight: 800 }}>{selectedTypes.length}</span>
                    )}
                  </div>
                  <span style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '4px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', width: '100%' }}>
                    {selectedTypes.length > 0 ? selectedTypes.map(t => t === 'flower' ? '花點' : t === 'mushroom' ? '菇點' : '探測器').join('、') : '全部類別'}
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() => setAdvancedSearchTab('tag')}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'flex-start',
                    padding: '12px 16px',
                    borderRadius: '16px',
                    border: '1px solid var(--border-medium)',
                    background: advancedSearchTab === 'tag' ? 'var(--surface-elevated)' : 'transparent',
                    boxShadow: advancedSearchTab === 'tag' ? '0 4px 10px rgba(0,0,0,0.04)' : 'none',
                    textAlign: 'left',
                    cursor: 'pointer',
                    width: '100%',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%', alignItems: 'center' }}>
                    <span style={{ fontWeight: 700, fontSize: '14px', color: 'var(--text-primary)' }}>標籤</span>
                    {selectedTags.length > 0 && (
                      <span style={{ background: '#34c759', color: '#fff', borderRadius: '50%', width: '18px', height: '18px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '10px', fontWeight: 800 }}>{selectedTags.length}</span>
                    )}
                  </div>
                  <span style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '4px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', width: '100%' }}>
                    {selectedTags.length > 0 ? selectedTags.map(t => `#${t}`).join('、') : '全部標籤'}
                  </span>
                </button>
              </div>

              {/* Right Selection Grid */}
              <div className="advanced-search-grid" style={{
                flex: 1,
                overflowY: 'auto',
                padding: '4px',
                border: '1px solid var(--border-light)',
                borderRadius: '16px',
                background: '#ffffff',
                maxHeight: '400px',
              }}>
                {advancedSearchTab === 'region' && (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: '10px', padding: '12px' }}>
                    {['亞洲', '歐洲', '北美洲', '南美洲', '大洋洲', '非洲', '南極洲', '台灣', '日本', '美國', '冰島', '義大利', '韓國', '越南', '未分類'].map((r) => {
                      const isSelected = selectedRegions.includes(r)
                      return (
                        <div
                          key={r}
                          onClick={() => {
                            if (isSelected) {
                              setSelectedRegions(selectedRegions.filter(x => x !== r))
                            } else {
                              setSelectedRegions([...selectedRegions, r])
                            }
                          }}
                          style={{
                            padding: '16px',
                            borderRadius: '14px',
                            border: isSelected ? '2px solid #34c759' : '1px solid var(--border-medium)',
                            background: isSelected ? '#f2fbf4' : 'var(--surface-elevated)',
                            cursor: 'pointer',
                            textAlign: 'center',
                            fontWeight: 700,
                            position: 'relative',
                            userSelect: 'none',
                          }}
                        >
                          {r}
                          {isSelected && (
                            <span style={{
                              position: 'absolute',
                              top: '6px',
                              right: '6px',
                              background: '#34c759',
                              color: '#fff',
                              borderRadius: '50%',
                              width: '16px',
                              height: '16px',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              fontSize: '9px',
                            }}>✓</span>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}

                {advancedSearchTab === 'type' && (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: '10px', padding: '12px' }}>
                    {[
                      { id: 'mushroom', label: '菇點' },
                      { id: 'flower', label: '花點' },
                      { id: 'postcard', label: '探測器' },
                    ].map((type) => {
                      const isSelected = selectedTypes.includes(type.id)
                      return (
                        <div
                          key={type.id}
                          onClick={() => {
                            if (isSelected) {
                              setSelectedTypes(selectedTypes.filter(x => x !== type.id))
                            } else {
                              setSelectedTypes([...selectedTypes, type.id])
                            }
                          }}
                          style={{
                            padding: '16px',
                            borderRadius: '14px',
                            border: isSelected ? '2px solid #34c759' : '1px solid var(--border-medium)',
                            background: isSelected ? '#f2fbf4' : 'var(--surface-elevated)',
                            cursor: 'pointer',
                            textAlign: 'center',
                            fontWeight: 700,
                            position: 'relative',
                            userSelect: 'none',
                          }}
                        >
                          {type.label}
                          {isSelected && (
                            <span style={{
                              position: 'absolute',
                              top: '6px',
                              right: '6px',
                              background: '#34c759',
                              color: '#fff',
                              borderRadius: '50%',
                              width: '16px',
                              height: '16px',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              fontSize: '9px',
                            }}>✓</span>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}

                {advancedSearchTab === 'tag' && (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: '10px', padding: '12px' }}>
                    {Array.from(new Set(savedLandmarks.flatMap((l) => l.tags || []).filter(Boolean))).length === 0 ? (
                      <p style={{ gridColumn: '1/-1', textAlign: 'center', padding: '24px', color: 'var(--text-secondary)' }}>尚未建立任何標籤</p>
                    ) : (
                      Array.from(new Set(savedLandmarks.flatMap((l) => l.tags || []).filter(Boolean))).map((tag) => {
                        const isSelected = selectedTags.includes(tag)
                        return (
                          <div
                            key={tag}
                            onClick={() => {
                              if (isSelected) {
                                setSelectedTags(selectedTags.filter(x => x !== tag))
                              } else {
                                setSelectedTags([...selectedTags, tag])
                              }
                            }}
                            style={{
                              padding: '16px',
                              borderRadius: '14px',
                              border: isSelected ? '2px solid #34c759' : '1px solid var(--border-medium)',
                              background: isSelected ? '#f2fbf4' : 'var(--surface-elevated)',
                              cursor: 'pointer',
                              textAlign: 'center',
                              fontWeight: 700,
                              position: 'relative',
                              userSelect: 'none',
                            }}
                          >
                            #{tag}
                            {isSelected && (
                              <span style={{
                                position: 'absolute',
                                top: '6px',
                                right: '6px',
                                background: '#34c759',
                                color: '#fff',
                                borderRadius: '50%',
                                width: '16px',
                                height: '16px',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                fontSize: '9px',
                              }}>✓</span>
                            )}
                          </div>
                        )
                      })
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Bottom Actions Bar */}
            <div className="modal-footer" style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '16px 24px 20px 24px',
              borderTop: 'none',
              background: 'transparent',
            }}>
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  setSelectedRegions([])
                  setSelectedTypes([])
                  setSelectedTags([])
                }}
                style={{
                  height: '40px',
                  borderRadius: '12px',
                  padding: '0 20px',
                  border: '1px solid var(--border-medium)',
                  background: '#fff',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                重設
              </button>
              <button
                type="button"
                className="primary-button"
                onClick={() => setIsAdvancedSearchOpen(false)}
                style={{
                  height: '40px',
                  borderRadius: '12px',
                  padding: '0 24px',
                  background: '#34c759',
                  color: '#fff',
                  border: 'none',
                  fontWeight: 700,
                  cursor: 'pointer',
                }}
              >
                完成
              </button>
            </div>
          </div>
        </div>
      )}

      

    </div>
  )
}
