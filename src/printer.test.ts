import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  createBrotherPrinter,
  NoGrantedDeviceError,
  type UsbLike,
  type UsbDeviceWithVendor,
} from './printer'
import type { UsbConfigurationLike } from './webUsbTransport'
import type { Raster1bpp } from './types'

const PRINTER_CONFIG: UsbConfigurationLike = {
  configurationValue: 1,
  interfaces: [
    {
      interfaceNumber: 0,
      alternates: [
        {
          endpoints: [
            { endpointNumber: 2, direction: 'out', type: 'bulk' },
            { endpointNumber: 1, direction: 'in', type: 'bulk' },
          ],
        },
      ],
    },
  ],
}

/** 32-byte status reply: clean, 12 mm tape. */
function statusReply(): { status: string; data: DataView } {
  const bytes = new Uint8Array(32)
  bytes[10] = 12
  return { status: 'ok', data: new DataView(bytes.buffer) }
}

function fakeUsbDevice(): { device: UsbDeviceWithVendor; log: string[] } {
  const log: string[] = []
  let configured = false
  const device: UsbDeviceWithVendor = {
    vendorId: 0x04f9,
    get configuration() {
      return configured ? PRINTER_CONFIG : null
    },
    async open() {
      log.push('open')
    },
    async close() {
      log.push('close')
    },
    async selectConfiguration() {
      configured = true
    },
    async claimInterface() {
      log.push('claim')
    },
    async releaseInterface() {
      log.push('release')
    },
    async transferOut(_ep, data) {
      log.push(`out(${data.length})`)
      return { status: 'ok', bytesWritten: data.length }
    },
    async transferIn() {
      log.push('in')
      return statusReply()
    },
  }
  return { device, log }
}

function fakeUsb(devices: UsbDeviceWithVendor[]): UsbLike & { requested: number } {
  const usb = {
    requested: 0,
    async getDevices() {
      return devices
    },
    async requestDevice() {
      usb.requested++
      const { device } = fakeUsbDevice()
      devices.push(device)
      return device
    },
  }
  return usb
}

const raster: Raster1bpp = { lineBytes: 16, lineCount: 1, rows: [new Uint8Array(16)] }
const jobOpts = { tapeWidthMm: 12, autoCut: true, marginDots: 0 }

describe('createBrotherPrinter', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('print() with no granted device rejects NoGrantedDeviceError and never opens a picker', async () => {
    const usb = fakeUsb([])
    const printer = createBrotherPrinter({ usb, serial: null, keepaliveMs: 0 })
    await expect(printer.print(raster, jobOpts)).rejects.toBeInstanceOf(NoGrantedDeviceError)
    expect(usb.requested).toBe(0)
  })

  it('print() uses a granted device, returns parsed status, and notifies listeners', async () => {
    const { device } = fakeUsbDevice()
    const printer = createBrotherPrinter({ usb: fakeUsb([device]), serial: null, keepaliveMs: 0 })
    const seen: unknown[] = []
    printer.onStatus((s) => seen.push(s))
    const status = await printer.print(raster, jobOpts)
    expect(status.hasError).toBe(false)
    expect(status.mediaWidthMm).toBe(12)
    expect(seen).toHaveLength(1)
  })

  it('requestDevice() grants, then print() succeeds', async () => {
    const usb = fakeUsb([])
    const printer = createBrotherPrinter({ usb, serial: null, keepaliveMs: 0 })
    await expect(printer.requestDevice()).resolves.toBe(true)
    expect(usb.requested).toBe(1)
    await expect(printer.print(raster, jobOpts)).resolves.toMatchObject({ hasError: false })
  })

  it('serializes print() against an in-flight operation (mutex)', async () => {
    const { device, log } = fakeUsbDevice()
    const printer = createBrotherPrinter({ usb: fakeUsb([device]), serial: null, keepaliveMs: 0 })
    const first = printer.print(raster, jobOpts)
    const second = printer.print(raster, jobOpts)
    await Promise.all([first, second])
    // Each job strictly opens → claims → transfers → releases → closes before the next starts.
    const opens = log.map((entry, i) => (entry === 'open' ? i : -1)).filter((i) => i >= 0)
    const closes = log.map((entry, i) => (entry === 'close' ? i : -1)).filter((i) => i >= 0)
    expect(opens).toHaveLength(2)
    expect(closes[0]).toBeLessThan(opens[1]!)
  })

  it('keepalive polls on the interval and fans out status; dispose() stops it', async () => {
    const { device } = fakeUsbDevice()
    const printer = createBrotherPrinter({ usb: fakeUsb([device]), serial: null, keepaliveMs: 1000 })
    const seen: unknown[] = []
    printer.onStatus((s) => seen.push(s))
    await vi.advanceTimersByTimeAsync(2100)
    expect(seen.length).toBe(2)
    printer.dispose()
    await vi.advanceTimersByTimeAsync(3000)
    expect(seen.length).toBe(2)
  })

  it('polls fast while absent, then relaxes to keepaliveMs once reachable', async () => {
    const devices: UsbDeviceWithVendor[] = []
    const printer = createBrotherPrinter({
      usb: fakeUsb(devices),
      serial: null,
      keepaliveMs: 10_000,
      absentPollMs: 1000,
    })
    const seen: unknown[] = []
    printer.onStatus((s) => seen.push(s))
    await vi.advanceTimersByTimeAsync(3100)
    expect(seen).toEqual([null, null, null]) // absent cadence
    devices.push(fakeUsbDevice().device) // printer powers on
    await vi.advanceTimersByTimeAsync(1000) // next absent-cadence tick finds it
    expect(seen).toHaveLength(4)
    expect(seen[3]).not.toBeNull()
    await vi.advanceTimersByTimeAsync(3000) // reachable now — no tick until keepaliveMs
    expect(seen).toHaveLength(4)
    await vi.advanceTimersByTimeAsync(7000) // 10 s after the reachable tick
    expect(seen).toHaveLength(5)
    printer.dispose()
  })

  it('drops back to fast polling when the printer vanishes', async () => {
    const devices: UsbDeviceWithVendor[] = [fakeUsbDevice().device]
    const printer = createBrotherPrinter({
      usb: fakeUsb(devices),
      serial: null,
      keepaliveMs: 10_000,
      absentPollMs: 1000,
    })
    const seen: unknown[] = []
    printer.onStatus((s) => seen.push(s))
    await vi.advanceTimersByTimeAsync(1100) // reachability unknown at start → absent cadence
    expect(seen).toHaveLength(1)
    expect(seen[0]).not.toBeNull()
    devices.length = 0 // printer powers off
    await vi.advanceTimersByTimeAsync(10_000) // keepalive-cadence tick discovers the absence
    expect(seen).toHaveLength(2)
    expect(seen[1]).toBeNull()
    await vi.advanceTimersByTimeAsync(1000) // fast again
    expect(seen).toHaveLength(3)
    printer.dispose()
  })

  it('keepalive notifies null when no device is present', async () => {
    const printer = createBrotherPrinter({ usb: fakeUsb([]), serial: null, keepaliveMs: 1000 })
    const seen: unknown[] = []
    printer.onStatus((s) => seen.push(s))
    await vi.advanceTimersByTimeAsync(1100)
    expect(seen).toEqual([null])
    printer.dispose()
  })

  it('queryMedia() returns the media spec for the loaded tape and notifies listeners', async () => {
    const { device } = fakeUsbDevice()
    const printer = createBrotherPrinter({ usb: fakeUsb([device]), serial: null, keepaliveMs: 0 })
    const seen: unknown[] = []
    printer.onStatus((s) => seen.push(s))
    const media = await printer.queryMedia()
    // fake replies with 12 mm tape -> documented 70-dot print area
    expect(media).toMatchObject({ tapeWidthMm: 12, printableDots: 70, dpi: 180 })
    expect(seen).toHaveLength(1)
  })

  it('queryMedia() returns null when no device is present', async () => {
    const printer = createBrotherPrinter({ usb: fakeUsb([]), serial: null, keepaliveMs: 0 })
    await expect(printer.queryMedia()).resolves.toBeNull()
  })

  it('onStatus unsubscribe stops callbacks; dispose() rejects further prints', async () => {
    const { device } = fakeUsbDevice()
    const printer = createBrotherPrinter({ usb: fakeUsb([device]), serial: null, keepaliveMs: 0 })
    const seen: unknown[] = []
    const off = printer.onStatus((s) => seen.push(s))
    off()
    await printer.print(raster, jobOpts)
    expect(seen).toHaveLength(0)
    printer.dispose()
    await expect(printer.print(raster, jobOpts)).rejects.toThrow('disposed')
  })
})
