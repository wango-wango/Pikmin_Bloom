/**
 * useTunnel — 查詢 tunneld daemon 狀態，每 5 秒自動更新。
 *
 * tunneld 在線時，後端會自動管理所有裝置的 RSD tunnel，
 * 不需要手動貼 RSD address/port。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { apiClient } from '../api/client'

export interface TunnelInfo {
  udid: string
  address: string
  port: number
  interface: string
}

export interface TunnelState {
  /** tunneld daemon 是否在線（sudo pymobiledevice3 remote tunneld） */
  tunneldAvailable: boolean
  /** 目前所有已知的 tunnel 清單 */
  tunnels: TunnelInfo[]
  /** 是否正在載入 */
  isLoading: boolean
}

const POLL_INTERVAL_MS = 5000

export function useTunnel(): TunnelState {
  const [state, setState] = useState<TunnelState>({
    tunneldAvailable: false,
    tunnels: [],
    isLoading: true,
  })
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedRef = useRef(true)

  const fetchStatus = useCallback(async () => {
    try {
      const result = await apiClient.getTunnelStatus()
      if (!mountedRef.current) return
      setState({
        tunneldAvailable: result.tunneldAvailable,
        tunnels: result.tunnels,
        isLoading: false,
      })
    } catch {
      if (!mountedRef.current) return
      setState((prev) => ({ ...prev, isLoading: false }))
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    void fetchStatus()

    const schedule = () => {
      timerRef.current = setTimeout(async () => {
        await fetchStatus()
        if (mountedRef.current) schedule()
      }, POLL_INTERVAL_MS)
    }
    schedule()

    return () => {
      mountedRef.current = false
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [fetchStatus])

  return state
}
