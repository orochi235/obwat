import type { JobOptions, PrinterStatus, Raster1bpp, Transport } from './types'
import { createBrotherRasterDriver, encodeStatusRequest } from './brotherDriver'
import { printRaster } from './printJob'
import { createWebUsbTransport, type UsbDeviceLike } from './webUsbTransport'
import { createWebSerialTransport, type SerialPortLike } from './webSerialTransport'

export const USB_VENDOR_BROTHER = 0x04f9

export type UsbDeviceWithVendor = UsbDeviceLike & { vendorId: number }

/** Structural subset of navigator.usb (injectable for tests). */
export interface UsbLike {
  getDevices(): Promise<UsbDeviceWithVendor[]>
  requestDevice(options: { filters: Array<{ vendorId: number }> }): Promise<UsbDeviceWithVendor>
}

/** Structural subset of navigator.serial (injectable for tests). */
export interface SerialLike {
  requestPort(): Promise<SerialPortLike>
}

/** print() found no already-granted device. The app decides picker vs. asleep-hint. */
export class NoGrantedDeviceError extends Error {
  constructor() {
    super('no granted printer device')
    this.name = 'NoGrantedDeviceError'
  }
}

export interface BrotherPrinterOptions {
  /** Status-poll interval that also keeps the printer awake; 0 disables. Default 60 s. */
  keepaliveMs?: number
  /** Override or disable (null) the WebUSB source. Default: navigator.usb when present. */
  usb?: UsbLike | null
  /** Override or disable (null) the Web Serial source. Default: navigator.serial when present. */
  serial?: SerialLike | null
}

export interface BrotherPrinter {
  /** Print via an already-granted device. Rejects NoGrantedDeviceError — never shows a picker. */
  print(raster: Raster1bpp, opts: JobOptions): Promise<PrinterStatus>
  /** Show the vendor-filtered picker (USB) or port picker (serial). Call inside a user gesture. */
  requestDevice(): Promise<boolean>
  /** One-shot status poll; null when the device is absent/unreachable (likely asleep). */
  queryStatus(): Promise<PrinterStatus | null>
  /** Fires after every print, keepalive tick, and queryStatus. Returns unsubscribe. */
  onStatus(cb: (status: PrinterStatus | null) => void): () => void
  dispose(): void
}

interface NavigatorLike {
  usb?: UsbLike
  serial?: SerialLike
}

/**
 * Connectionless session over a Brother P-touch printer. No consumer-visible
 * open/close: every operation acquires the device, claims, works, and releases,
 * serialized by an internal mutex — the printer auto-sleeps and vanishes from
 * enumeration, so "connected" is never a stable state worth exposing.
 */
export function createBrotherPrinter(options: BrotherPrinterOptions = {}): BrotherPrinter {
  const nav = (globalThis as { navigator?: NavigatorLike }).navigator
  const usb = options.usb === undefined ? (nav?.usb ?? null) : options.usb
  const serial = options.serial === undefined ? (nav?.serial ?? null) : options.serial
  const keepaliveMs = options.keepaliveMs ?? 60_000

  let serialPort: SerialPortLike | null = null
  let disposed = false
  const listeners = new Set<(status: PrinterStatus | null) => void>()
  const notify = (status: PrinterStatus | null) => {
    for (const cb of listeners) cb(status)
  }

  // Serializes device operations (prints, keepalive ticks, status polls) so a
  // claim is never attempted while another operation holds the interface.
  let chain: Promise<unknown> = Promise.resolve()
  const withLock = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn)
    chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  const grantedUsbDevice = async (): Promise<UsbDeviceWithVendor | null> =>
    usb ? ((await usb.getDevices()).find((d) => d.vendorId === USB_VENDOR_BROTHER) ?? null) : null

  /** Transport for an already-available device, or null when none. */
  const acquireTransport = async (): Promise<Transport | null> => {
    const device = await grantedUsbDevice()
    if (device) return createWebUsbTransport(device)
    if (serialPort) return createWebSerialTransport(serialPort, { baudRate: 9600 })
    return null
  }

  const pollStatus = async (): Promise<PrinterStatus | null> => {
    const transport = await acquireTransport()
    if (!transport) return null
    await transport.open()
    try {
      await transport.write(encodeStatusRequest())
      const raw = await transport.read(2000, 32)
      return createBrotherRasterDriver().parseStatus(raw)
    } finally {
      await transport.close().catch(() => {})
    }
  }

  const keepaliveTick = async () => {
    let status: PrinterStatus | null = null
    try {
      status = await pollStatus()
    } catch {
      status = null
    }
    notify(status)
  }

  let keepaliveHandle: ReturnType<typeof setInterval> | null = null
  if (keepaliveMs > 0) {
    keepaliveHandle = setInterval(() => {
      if (!disposed) void withLock(keepaliveTick)
    }, keepaliveMs)
  }

  const assertLive = () => {
    if (disposed) throw new Error('printer disposed')
  }

  return {
    print: async (raster, opts) => {
      assertLive()
      return withLock(async () => {
        const transport = await acquireTransport()
        if (!transport) throw new NoGrantedDeviceError()
        const status = await printRaster(raster, {
          driver: createBrotherRasterDriver(),
          transport,
          opts,
        })
        notify(status)
        return status
      })
    },

    requestDevice: async () => {
      assertLive()
      // Deliberately NOT under the mutex: must run directly in the user
      // gesture, and the picker can stay open indefinitely.
      if (usb) {
        await usb.requestDevice({ filters: [{ vendorId: USB_VENDOR_BROTHER }] })
        return true
      }
      if (serial) {
        serialPort = await serial.requestPort()
        return true
      }
      throw new Error('neither WebUSB nor Web Serial is available')
    },

    queryStatus: async () => {
      assertLive()
      return withLock(async () => {
        let status: PrinterStatus | null = null
        try {
          status = await pollStatus()
        } catch {
          status = null
        }
        notify(status)
        return status
      })
    },

    onStatus: (cb) => {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },

    dispose: () => {
      disposed = true
      if (keepaliveHandle !== null) clearInterval(keepaliveHandle)
      listeners.clear()
    },
  }
}
