import { describe, it, expect } from 'vitest'
import { printRaster } from './printJob'
import { createBrotherRasterDriver } from './brotherDriver'
import type { Raster1bpp, Transport, JobOptions } from './types'

function recordingTransport() {
  const events: string[] = []
  const writes: Uint8Array[] = []
  const transport: Transport = {
    async open() { events.push('open') },
    async write(b) { events.push('write'); writes.push(b) },
    async read() { events.push('read'); return Uint8Array.from([0x80, 0x00]) },
    async close() { events.push('close') },
  }
  return { transport, events, writes }
}

const raster: Raster1bpp = { lineBytes: 16, lineCount: 1, rows: [new Uint8Array(16)] }
const opts: JobOptions = { tapeWidthMm: 12, autoCut: true, marginDots: 0 }

describe('printRaster', () => {
  it('opens, writes encoded bytes, reads status, and closes in order', async () => {
    const { transport, events, writes } = recordingTransport()
    await printRaster(raster, { driver: createBrotherRasterDriver(), transport, opts })
    expect(events[0]).toBe('open')
    expect(events[events.length - 1]).toBe('close')
    expect(events).toContain('write')
    expect(writes[0][0]).toBe(0x00) // first encoded byte is the invalidate run
  })

  it('always closes even if write throws', async () => {
    const events: string[] = []
    const transport: Transport = {
      async open() { events.push('open') },
      async write() { throw new Error('boom') },
      async read() { return new Uint8Array(0) },
      async close() { events.push('close') },
    }
    await expect(
      printRaster(raster, { driver: createBrotherRasterDriver(), transport, opts }),
    ).rejects.toThrow('boom')
    expect(events).toContain('close')
  })

  it('requests the full 32-byte status with a 2000ms timeout', async () => {
    const reads: [number, number | undefined][] = []
    const transport: Transport = {
      async open() {},
      async write() {},
      async read(timeoutMs, minBytes) {
        reads.push([timeoutMs, minBytes])
        return new Uint8Array(32)
      },
      async close() {},
    }
    await printRaster(raster, { driver: createBrotherRasterDriver(), transport, opts })
    expect(reads).toEqual([[2000, 32]])
  })

  it('returns the status parsed via driver.parseStatus', async () => {
    const transport: Transport = {
      async open() {},
      async write() {},
      async read() {
        const raw = new Uint8Array(32)
        raw[8] = 0x01
        return raw
      },
      async close() {},
    }
    const result = await printRaster(raster, { driver: createBrotherRasterDriver(), transport, opts })
    expect(result.hasError).toBe(true)
  })

  it('resolves with the status even when close() rejects', async () => {
    const transport: Transport = {
      async open() {},
      async write() {},
      async read() { return new Uint8Array(32) },
      async close() { throw new Error('close boom') },
    }
    const result = await printRaster(raster, { driver: createBrotherRasterDriver(), transport, opts })
    expect(result.hasError).toBe(false)
  })

  it('surfaces the write error when both write() and close() fail', async () => {
    const transport: Transport = {
      async open() {},
      async write() { throw new Error('boom') },
      async read() { return new Uint8Array(0) },
      async close() { throw new Error('close boom') },
    }
    await expect(
      printRaster(raster, { driver: createBrotherRasterDriver(), transport, opts }),
    ).rejects.toThrow('boom')
  })

  it('clean success: a full 32-byte zero status resolves with no error and complete', async () => {
    const transport: Transport = {
      async open() {},
      async write() {},
      async read() { return new Uint8Array(32) },
      async close() {},
    }
    const result = await printRaster(raster, { driver: createBrotherRasterDriver(), transport, opts })
    expect(result.hasError).toBe(false)
    expect(result.incomplete).toBe(false)
  })
})
