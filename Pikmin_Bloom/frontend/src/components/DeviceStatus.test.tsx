import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DeviceStatus } from './DeviceStatus'
import * as useDeviceModule from '../hooks/useDevice'
import type { DeviceInfo } from '../types'

vi.mock('../hooks/useDevice')
vi.mock('../api/client', () => ({
  apiClient: {
    revealDeveloperMode: vi.fn(),
  },
}))

const mockUseDevice = vi.spyOn(useDeviceModule, 'useDevice')

const mockDevice: DeviceInfo = {
  id: 'device-001',
  name: 'My iPhone',
  isConnected: true,
  model: 'iPhone 15',
}

const disconnectedDevice: DeviceInfo = {
  id: 'device-002',
  name: 'Old iPhone',
  isConnected: false,
}

function setupMock(overrides: Partial<ReturnType<typeof useDeviceModule.useDevice>>) {
  mockUseDevice.mockReturnValue({
    devices: [],
    selectedDevice: null,
    selectDevice: vi.fn(),
    isLoading: false,
    error: null,
    ...overrides,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('DeviceStatus', () => {
  it('shows loading state', () => {
    setupMock({ isLoading: true })
    render(<DeviceStatus />)
    expect(screen.getByText('載入裝置中...')).toBeTruthy()
  })

  it('shows error state', () => {
    setupMock({ error: 'Network error' })
    render(<DeviceStatus />)
    expect(screen.getByText(/Network error/)).toBeTruthy()
  })

  it('shows empty state', () => {
    setupMock({ devices: [] })
    const { container } = render(<DeviceStatus />)
    expect(container.firstChild).toBeNull()
  })

  it('renders available devices', () => {
    setupMock({ devices: [mockDevice] })
    render(<DeviceStatus />)
    expect(screen.getByRole('combobox')).toBeTruthy()
    expect(screen.getByText('My iPhone (iPhone 15)')).toBeTruthy()
  })

  it('shows connected text for selected device', () => {
    setupMock({ devices: [mockDevice], selectedDevice: mockDevice })
    render(<DeviceStatus />)
    expect(screen.getByText('已連線')).toBeTruthy()
  })

  it('shows disconnected text for selected device', () => {
    setupMock({ devices: [disconnectedDevice], selectedDevice: disconnectedDevice })
    render(<DeviceStatus />)
    expect(screen.getByText('未連線')).toBeTruthy()
  })

  it('calls selectDevice when the selection changes', async () => {
    const selectDevice = vi.fn()
    setupMock({ devices: [mockDevice], selectDevice })
    render(<DeviceStatus />)
    const select = screen.getByRole('combobox')
    await userEvent.selectOptions(select, 'device-001')
    expect(selectDevice).toHaveBeenCalledWith('device-001')
  })

  it('calls onDeviceSelect with selectedDevice', () => {
    const onDeviceSelect = vi.fn()
    setupMock({ devices: [mockDevice], selectedDevice: mockDevice })
    render(<DeviceStatus onDeviceSelect={onDeviceSelect} />)
    expect(onDeviceSelect).toHaveBeenCalledWith(mockDevice)
  })

  it('calls onDeviceSelect(null) when selectedDevice is null', () => {
    const onDeviceSelect = vi.fn()
    setupMock({ devices: [mockDevice], selectedDevice: null })
    render(<DeviceStatus onDeviceSelect={onDeviceSelect} />)
    expect(onDeviceSelect).toHaveBeenCalledWith(null)
  })
})
