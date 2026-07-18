import type { Transport } from './types'

/** Minimal structural subset of WebUSB's `USBDevice` we depend on (testable with a plain fake). */
export interface UsbEndpointLike {
  endpointNumber: number
  direction: 'in' | 'out'
  type: 'bulk' | 'interrupt' | 'isochronous'
}

export interface UsbInterfaceLike {
  interfaceNumber: number
  alternates: Array<{ endpoints: UsbEndpointLike[] }>
}

export interface UsbConfigurationLike {
  configurationValue: number
  interfaces: UsbInterfaceLike[]
}

export interface UsbDeviceLike {
  readonly configuration: UsbConfigurationLike | null
  open(): Promise<void>
  close(): Promise<void>
  selectConfiguration(value: number): Promise<void>
  claimInterface(interfaceNumber: number): Promise<void>
  releaseInterface(interfaceNumber: number): Promise<void>
  transferOut(endpointNumber: number, data: Uint8Array): Promise<{ status?: string; bytesWritten: number }>
  transferIn(endpointNumber: number, length: number): Promise<{ status?: string; data?: DataView }>
}

const READ_PACKET_SIZE = 64 // PT-P710BT bulk max packet size; fine for any full-speed device

export function createWebUsbTransport(device: UsbDeviceLike): Transport {
  let claimed: { interfaceNumber: number; epIn: number; epOut: number } | null = null

  return {
    async open() {
      await device.open()
      if (device.configuration === null) await device.selectConfiguration(1)
      const config = device.configuration
      if (!config) throw new Error('USB device has no active configuration')
      let found: { interfaceNumber: number; epIn: number; epOut: number } | null = null
      for (const iface of config.interfaces) {
        const endpoints = iface.alternates[0]?.endpoints ?? []
        const bulkIn = endpoints.find((e) => e.type === 'bulk' && e.direction === 'in')
        const bulkOut = endpoints.find((e) => e.type === 'bulk' && e.direction === 'out')
        if (bulkIn && bulkOut) {
          found = {
            interfaceNumber: iface.interfaceNumber,
            epIn: bulkIn.endpointNumber,
            epOut: bulkOut.endpointNumber,
          }
          break
        }
      }
      if (!found) throw new Error('no USB interface with bulk IN and OUT endpoints')
      await device.claimInterface(found.interfaceNumber)
      claimed = found
    },

    async write(bytes: Uint8Array) {
      if (!claimed) throw new Error('USB transport not open')
      // Chromium packetizes a large transferOut internally; jobs are a few KB.
      const result = await device.transferOut(claimed.epOut, bytes)
      if (result.status !== 'ok') throw new Error(`USB write failed: ${result.status}`)
      if (result.bytesWritten !== bytes.length)
        throw new Error(`USB short write: ${result.bytesWritten}/${bytes.length}`)
    },

    async read(timeoutMs: number, minBytes: number = 1) {
      if (!claimed) throw new Error('USB transport not open')
      const deadline = Date.now() + timeoutMs
      const accumulated: number[] = []
      while (accumulated.length < minBytes) {
        const remainingMs = deadline - Date.now()
        if (remainingMs <= 0) break
        let timeoutHandle: ReturnType<typeof setTimeout> | null = null
        // WebUSB has no native transfer timeout. On deadline we abandon the pending
        // transferIn; close() (device.close) tears it down — like the serial
        // transport, read() is effectively single-use per open().
        let result: { status?: string; data?: DataView } | null
        try {
          result = await Promise.race([
            device.transferIn(claimed.epIn, READ_PACKET_SIZE),
            new Promise<null>((resolve) => {
              timeoutHandle = setTimeout(() => resolve(null), remainingMs)
            }),
          ])
        } finally {
          if (timeoutHandle !== null) clearTimeout(timeoutHandle)
        }
        if (result === null) break
        if (result.data) {
          for (let i = 0; i < result.data.byteLength; i++) accumulated.push(result.data.getUint8(i))
        }
        if (result.status !== 'ok') break // stall/babble: stop and return what we have
      }
      return new Uint8Array(accumulated)
    },

    async close() {
      // Best-effort on both halves: a close failure must not mask the job's outcome.
      if (claimed) {
        await device.releaseInterface(claimed.interfaceNumber).catch(() => {})
        claimed = null
      }
      await device.close().catch(() => {})
    },
  }
}
