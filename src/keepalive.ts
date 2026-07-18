import type { PrinterStatus } from './types'
import { createBrotherRasterDriver, encodeStatusRequest } from './brotherDriver'
import { createWebUsbTransport, type UsbDeviceLike } from './webUsbTransport'

export interface UsbKeepaliveOptions {
  /** Resolve the currently-granted printer, or null when absent/asleep. */
  getDevice(): Promise<UsbDeviceLike | null>
  /** True while a print job is running — the tick yields to it. */
  isBusy(): boolean
  intervalMs?: number
  /** Called after every tick: parsed status on success, null when absent or failed. */
  onStatus?(status: PrinterStatus | null): void
}

export interface UsbKeepalive {
  /** Stop polling. */
  stop(): void
  /** Resolves once any in-flight tick has finished (immediately when idle). */
  idle(): Promise<void>
}

/**
 * Periodically round-trips a status request so the PT-P710BT's idle
 * auto-power-off timer keeps getting reset while the app is open. The claim is
 * held only for the duration of one poll so other software can use the printer
 * between ticks. Opportunistic: every failure is swallowed. Callers that need
 * exclusive device access await `idle()` first.
 */
export function startUsbKeepalive(options: UsbKeepaliveOptions): UsbKeepalive {
  const intervalMs = options.intervalMs ?? 5 * 60_000
  let inFlight: Promise<void> | null = null

  const tick = async () => {
    let status: PrinterStatus | null = null
    try {
      const device = await options.getDevice()
      if (!device) return
      const transport = createWebUsbTransport(device)
      await transport.open()
      try {
        await transport.write(encodeStatusRequest())
        const raw = await transport.read(2000, 32)
        status = createBrotherRasterDriver().parseStatus(raw)
      } finally {
        await transport.close()
      }
    } catch (err) {
      console.warn('USB keepalive tick failed:', err)
    } finally {
      options.onStatus?.(status)
    }
  }

  const runTick = () => {
    if (inFlight || options.isBusy()) return
    inFlight = tick().finally(() => {
      inFlight = null
    })
  }

  const handle = setInterval(runTick, intervalMs)
  return {
    stop: () => clearInterval(handle),
    idle: () => inFlight ?? Promise.resolve(),
  }
}
