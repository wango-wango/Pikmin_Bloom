import { useState } from 'react'
import { Search, MapPin, Loader2, X } from 'lucide-react'
import { apiClient } from '../api/client'

interface SearchResult {
  name: string
  latitude: number
  longitude: number
}

interface LocationSearchProps {
  onLocationSelect: (lat: number, lng: number) => void
  disabled?: boolean
}

export function LocationSearch({ onLocationSelect, disabled }: LocationSearchProps) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [isOpen, setIsOpen] = useState(false)

  const handleSearch = async () => {
    if (!query.trim()) return
    setLoading(true)
    setIsOpen(true)
    try {
      const data = await apiClient.searchLocation(query)
      setResults(data)
    } catch (err) {
      console.error(err)
      setResults([])
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="location-search-container" style={{ position: 'relative', marginBottom: '12px' }}>
      <div className="search-input-wrapper" style={{ display: 'flex', gap: '8px' }}>
        <div style={{ position: 'relative', flex: 1 }}>
          <Search size={16} strokeWidth={2.4} style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
          <input
            type="text"
            className="text-input"
            placeholder="搜尋地名 (如: 迪士尼)"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleSearch()
            }}
            disabled={disabled}
            style={{ paddingLeft: '36px', width: '100%', height: '40px', borderRadius: '7px', border: '1px solid var(--border-medium)' }}
          />
          {query && (
            <button
              type="button"
              className="clear-search-btn"
              onClick={() => {
                setQuery('')
                setResults([])
                setIsOpen(false)
              }}
              style={{ position: 'absolute', right: '12px', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)' }}
            >
              <X size={16} strokeWidth={2.4} />
            </button>
          )}
        </div>
        <button
          type="button"
          className="secondary-button"
          onClick={() => void handleSearch()}
          disabled={disabled || !query.trim() || loading}
          style={{ padding: '0 16px', height: '40px' }}
        >
          {loading ? <Loader2 size={16} className="spinner" /> : '搜尋'}
        </button>
      </div>

      {isOpen && (
        <div className="search-results-dropdown" style={{
          position: 'absolute',
          top: '100%',
          left: 0,
          right: 0,
          marginTop: '4px',
          background: 'var(--surface-elevated)',
          border: '1px solid var(--border-medium)',
          borderRadius: '8px',
          boxShadow: 'var(--shadow-panel)',
          zIndex: 100,
          maxHeight: '300px',
          overflowY: 'auto'
        }}>
          {loading ? (
            <div style={{ padding: '16px', textAlign: 'center', color: 'var(--text-muted)' }}>搜尋中...</div>
          ) : results.length > 0 ? (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {results.map((result, i) => (
                <li key={i}>
                  <button
                    type="button"
                    onClick={() => {
                      onLocationSelect(result.latitude, result.longitude)
                      setIsOpen(false)
                    }}
                    style={{
                      width: '100%',
                      padding: '12px 16px',
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: '12px',
                      background: 'transparent',
                      border: 'none',
                      borderBottom: i < results.length - 1 ? '1px solid var(--border-divider)' : 'none',
                      textAlign: 'left',
                      cursor: 'pointer'
                    }}
                  >
                    <MapPin size={18} style={{ color: 'var(--text-muted)', flexShrink: 0, marginTop: '2px' }} />
                    <div>
                      <div style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: '14px', lineHeight: '1.4' }}>
                        {result.name}
                      </div>
                      <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' }}>
                        {result.latitude.toFixed(6)}, {result.longitude.toFixed(6)}
                      </div>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div style={{ padding: '16px', textAlign: 'center', color: 'var(--text-muted)' }}>找不到相關地點</div>
          )}
        </div>
      )}
    </div>
  )
}
