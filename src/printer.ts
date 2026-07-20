import type { JobOptions, MediaSpec, PrinterStatus, Raster1bpp, Transport } from './types'
import { createBrotherRasterDriver, encodeStatusRequest } from './brotherDriver'
import { mediaForStatus } from './profiles'
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
  /** Status-poll interval while the printer is reachable — also keeps it awake;
   *  0 disables all polling. Default 60 s. */
  keepaliveMs?: number
  /** Poll interval while no device is enumerated (off/asleep). Absent polls are
   *  just a getDevices() check — no device I/O — so this runs fast to catch
   *  power-on quickly. Default min(3 s, keepaliveMs). */
  absentPollMs?: number
  /** Override or disable (null) the WebUSB source. Default: navigator.usb when present. */
  usb?: UsbLike | null
  /** Override or disable (null) the Web Serial source. Default: navigator.serial when present. */
  serial?: SerialLike | null
}

export interface BrotherPrinter {
  /** Print via an already-granted device; rejects NoGrantedDeviceError, never
   *  shows a picker. An array prints a multi-page strip in one job — the
   *  cutter fires between pages when auto-cut is on. */
  print(raster: Raster1bpp | readonly Raster1bpp[], opts: JobOptions): Promise<PrinterStatus>
  /** Show the vendor-filtered picker (USB) or port picker (serial). Call inside a user gesture. */
  requestDevice(): Promise<boolean>
  /** One-shot status poll; null when the device is absent/unreachable (likely asleep). */
  queryStatus(): Promise<PrinterStatus | null>
  /**
   * Media spec for the loaded tape (status poll + profile lookup): tells the
   * consumer what geometry to render (height = printableDots at dpi). Null when
   * the device is absent/asleep or the reply carries no usable tape width.
   */
  queryMedia(): Promise<MediaSpec | null>
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
  const absentPollMs = options.absentPollMs ?? Math.min(3_000, keepaliveMs)

  let serialPort: SerialPortLike | null = null
  let disposed = false
  const listeners = new Set<(status: PrinterStatus | null) => void>()
  // Every status observation — keepalive tick, manual query, or print — feeds
  // reachability, which picks the polling cadence below.
  let reachable = false
  const notify = (status: PrinterStatus | null) => {
    reachable = status !== null
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

  // Self-scheduling timeout chain, not setInterval: the next tick is armed
  // only after the previous one finishes, so ticks can't pile up behind a
  // long print, and each delay adapts to reachability — fast while absent
  // (cheap enumeration check), keepalive cadence while reachable (real
  // open/claim/status I/O). Reachability starts unknown, so the first poll
  // runs at the fast cadence and settles the chip promptly after load.
  let keepaliveHandle: ReturnType<typeof setTimeout> | null = null
  const armKeepalive = () => {
    if (disposed) return
    keepaliveHandle = setTimeout(() => {
      void withLock(keepaliveTick).then(armKeepalive)
    }, reachable ? keepaliveMs : absentPollMs)
  }
  if (keepaliveMs > 0) armKeepalive()

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

    queryMedia: async () => {
      assertLive()
      return withLock(async () => {
        let status: PrinterStatus | null = null
        try {
          status = await pollStatus()
        } catch {
          status = null
        }
        notify(status)
        return status ? mediaForStatus(status) : null
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
      if (keepaliveHandle !== null) clearTimeout(keepaliveHandle)
      listeners.clear()
    },
  }
}
