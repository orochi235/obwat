import type { Transport } from './types'

/** Minimal structural subset of the Web Serial `SerialPort` we depend on. */
export interface SerialPortLike {
  open(options: { baudRate: number }): Promise<void>
  close(): Promise<void>
  readonly writable: { getWriter(): { write(chunk: Uint8Array): Promise<void>; releaseLock(): void } } | null
  readonly readable: {
    getReader(): {
      read(): Promise<{ value?: Uint8Array; done: boolean }>
      releaseLock(): void
      cancel(): Promise<void>
    }
  } | null
}

export interface WebSerialOptions {
  baudRate: number // SPP ignores this, but Web Serial requires a value
}

export function createWebSerialTransport(port: SerialPortLike, options: WebSerialOptions): Transport {
  return {
    async open() {
      await port.open({ baudRate: options.baudRate })
    },
    async write(bytes: Uint8Array) {
      if (!port.writable) throw new Error('serial port not writable')
      const writer = port.writable.getWriter()
      try {
        // writer.write() means "queued", not "transmitted" — the print flow relies on
        // the subsequent status read() blocking until the printer has consumed the data
        await writer.write(bytes)
      } finally {
        writer.releaseLock()
      }
    },
    async read(timeoutMs: number, minBytes: number = 1) {
      if (!port.readable) throw new Error('serial port not readable')
      const reader = port.readable.getReader()
      const deadline = Date.now() + timeoutMs
      const accumulated: number[] = []
      let timeoutHandle: ReturnType<typeof setTimeout> | null = null

      try {
        while (accumulated.length < minBytes) {
          const remainingMs = Math.max(0, deadline - Date.now())
          if (remainingMs === 0) break

          const timeoutPromise = new Promise<{ value?: Uint8Array; done: boolean }>((resolve) => {
            timeoutHandle = setTimeout(() => resolve({ value: undefined, done: false }), remainingMs)
          })

          try {
            const result = await Promise.race([reader.read(), timeoutPromise])
            if (timeoutHandle !== null) clearTimeout(timeoutHandle)
            timeoutHandle = null

            if (result.value) {
              accumulated.push(...Array.from(result.value))
            }
            if (result.done) break
          } catch (e) {
            if (timeoutHandle !== null) clearTimeout(timeoutHandle)
            timeoutHandle = null
            throw e
          }
        }

        return new Uint8Array(accumulated)
      } finally {
        if (timeoutHandle !== null) clearTimeout(timeoutHandle)
        await reader.cancel().catch(() => {})
        reader.releaseLock()
      }
    },
    async close() {
      await port.close()
    },
  }
}
