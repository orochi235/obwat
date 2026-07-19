import { describe, it, expect } from 'vitest'
import { createBrotherRasterDriver } from './brotherDriver'
import { packbits } from './packbits'
import type { Raster1bpp, JobOptions } from './types'

const opts: JobOptions = { tapeWidthMm: 12, autoCut: true, marginDots: 0 }

function blankRaster(lineCount: number): Raster1bpp {
  return { lineBytes: 16, lineCount, rows: Array.from({ length: lineCount }, () => new Uint8Array(16)) }
}

describe('BrotherRasterDriver', () => {
  it('emits the documented header, blank-line opcode, and print-cut footer', () => {
    const out = Array.from(createBrotherRasterDriver().encode(blankRaster(1), opts))
    const expected = [
      ...new Array(100).fill(0x00), // invalidate
      0x1b, 0x40, // init
      0x1b, 0x69, 0x53, // status request
      0x1b, 0x69, 0x61, 0x01, // raster mode
      0x1b, 0x69, 0x21, 0x00, // status notification mode
      0x1b, 0x69, 0x7a, 0x84, 0x00, 0x0c, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, // print info (12mm, 1 line)
      0x1b, 0x69, 0x4d, 0x40, // auto-cut
      0x1b, 0x69, 0x4b, 0x08, // advanced mode
      0x1b, 0x69, 0x64, 0x00, 0x00, // margin
      0x4d, 0x02, // compression
      0x5a, // blank raster line
      0x1a, // print + feed + cut
    ]
    expect(out).toEqual(expected)
  })

  it('emits 0x47 + LE length + packbits for a non-blank line', () => {
    const row = new Uint8Array(16)
    row[0] = 0xff
    const raster: Raster1bpp = { lineBytes: 16, lineCount: 1, rows: [row] }
    const out = Array.from(createBrotherRasterDriver().encode(raster, opts))
    const payload = Array.from(packbits(row))
    const gIndex = out.lastIndexOf(0x47)
    expect(gIndex).toBeGreaterThan(-1)
    expect(out[gIndex + 1]).toBe(payload.length & 0xff)
    expect(out[gIndex + 2]).toBe((payload.length >> 8) & 0xff)
    expect(out.slice(gIndex + 3, gIndex + 3 + payload.length)).toEqual(payload)
  })

  it('clears the auto-cut bit when autoCut is false', () => {
    const out = Array.from(createBrotherRasterDriver().encode(blankRaster(1), { ...opts, autoCut: false }))
    const idx = out.findIndex((b, i) => b === 0x1b && out[i + 1] === 0x69 && out[i + 2] === 0x4d)
    expect(idx).toBeGreaterThan(-1)
    expect(out[idx + 3]).toBe(0x00)
  })

  it('encodes multi-byte raster count in print-info (lineCount: 300)', () => {
    const out = Array.from(createBrotherRasterDriver().encode(blankRaster(300), opts))
    const idx = out.findIndex((b, i) => b === 0x1b && out[i + 1] === 0x69 && out[i + 2] === 0x7a)
    expect(idx).toBeGreaterThan(-1)
    // raster count is at +7..+10 (4-byte LE): 300 = 0x012c = [0x2c, 0x01, 0x00, 0x00]
    expect(out.slice(idx + 7, idx + 11)).toEqual([0x2c, 0x01, 0x00, 0x00])
  })

  it('parseStatus reports hasError for a set bit at offset 8', () => {
    const raw = new Uint8Array(32)
    raw[8] = 0x01
    expect(createBrotherRasterDriver().parseStatus(raw).hasError).toBe(true)
  })

  it('parseStatus reports hasError for a set bit at offset 9', () => {
    const raw = new Uint8Array(32)
    raw[9] = 0x01
    expect(createBrotherRasterDriver().parseStatus(raw).hasError).toBe(true)
  })

  it('parseStatus reports no error for 32 zero bytes, and complete', () => {
    const raw = new Uint8Array(32)
    const status = createBrotherRasterDriver().parseStatus(raw)
    expect(status.hasError).toBe(false)
    expect(status.incomplete).toBe(false)
  })

  it('parseStatus reports no error for a short reply (<10 bytes), and incomplete', () => {
    const raw = Uint8Array.from([0x80, 0x00])
    const status = createBrotherRasterDriver().parseStatus(raw)
    expect(status.hasError).toBe(false)
    expect(status.incomplete).toBe(true)
  })

  it('parseStatus extracts media width from byte 10', () => {
    const raw = new Uint8Array(32)
    raw[10] = 12
    expect(createBrotherRasterDriver().parseStatus(raw).mediaWidthMm).toBe(12)
  })

  it('parseStatus reports null media width for an incomplete reply', () => {
    const raw = new Uint8Array(16)
    raw[10] = 12
    expect(createBrotherRasterDriver().parseStatus(raw).mediaWidthMm).toBeNull()
  })

  // Captured from a real PT-P710BT with 12 mm white/black laminated TZe loaded
  // (docs/hardware/pt-p710bt.md).
  const capturedReply = Uint8Array.from([
    0x80, 0x20, 0x42, 0x30, 0x76, 0x30, 0x00, 0x00, 0x00, 0x00, 0x0c, 0x01, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  ])

  it('parseStatus decodes cassette metadata from a real captured reply', () => {
    const status = createBrotherRasterDriver().parseStatus(capturedReply)
    expect(status.mediaWidthMm).toBe(12)
    expect(status.mediaType).toBe('laminated')
    expect(status.tapeColor).toBe('white')
    expect(status.textColor).toBe('black')
  })

  it('parseStatus decodes heat-shrink media types', () => {
    const raw = new Uint8Array(32)
    raw[11] = 0x11
    expect(createBrotherRasterDriver().parseStatus(raw).mediaType).toBe('heat-shrink-2-1')
    raw[11] = 0x17
    expect(createBrotherRasterDriver().parseStatus(raw).mediaType).toBe('heat-shrink-3-1')
  })

  it('parseStatus decodes no-media and incompatible cassette states', () => {
    const raw = new Uint8Array(32)
    expect(createBrotherRasterDriver().parseStatus(raw).mediaType).toBe('no-media')
    raw[11] = 0xff
    raw[24] = 0xff
    raw[25] = 0xff
    const status = createBrotherRasterDriver().parseStatus(raw)
    expect(status.mediaType).toBe('incompatible')
    expect(status.tapeColor).toBe('incompatible')
    expect(status.textColor).toBe('incompatible')
  })

  it('parseStatus decodes special tape colors', () => {
    const raw = new Uint8Array(32)
    raw[24] = 0x23 // Satin Gold
    raw[25] = 0x0a // Gold text
    const status = createBrotherRasterDriver().parseStatus(raw)
    expect(status.tapeColor).toBe('satin-gold')
    expect(status.textColor).toBe('gold')
  })

  it('parseStatus maps unrecognized cassette codes to unknown', () => {
    const raw = new Uint8Array(32)
    raw[11] = 0x42
    raw[24] = 0x42
    raw[25] = 0x42
    const status = createBrotherRasterDriver().parseStatus(raw)
    expect(status.mediaType).toBe('unknown')
    expect(status.tapeColor).toBe('unknown')
    expect(status.textColor).toBe('unknown')
  })

  it('parseStatus reports null cassette metadata for an incomplete reply', () => {
    const raw = new Uint8Array(16)
    raw[11] = 0x01
    const status = createBrotherRasterDriver().parseStatus(raw)
    expect(status.mediaType).toBeNull()
    expect(status.tapeColor).toBeNull()
    expect(status.textColor).toBeNull()
  })
})
