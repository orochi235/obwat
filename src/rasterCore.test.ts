import { describe, it, expect } from 'vitest'
import { rgbaToRaster } from './rasterCore'
import type { RgbaImage, MediaSpec } from './types'

// helper: build an RGBA image from a width x height map of booleans (true = black)
function img(width: number, height: number, black: (x: number, y: number) => boolean): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const v = black(x, y) ? 0 : 255
      data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255
    }
  }
  return { width, height, data }
}

const media: MediaSpec = { dpi: 180, printheadDots: 128, printableDots: 8, tapeWidthMm: 12 }

describe('rgbaToRaster', () => {
  it('produces one row per image column', () => {
    const r = rgbaToRaster(img(3, 8, () => false), media)
    expect(r.lineCount).toBe(3)
    expect(r.lineBytes).toBe(16)
    expect(r.rows).toHaveLength(3)
    expect(Array.from(r.rows[0])).toEqual(new Array(16).fill(0))
  })

  it('sets the correct centered bit for a single black pixel', () => {
    // printableDots=8 centered in 128 -> offset = (128-8)/2 = 60. Pixel at column 1, y=0 -> dot 60.
    const r = rgbaToRaster(img(3, 8, (x, y) => x === 1 && y === 0), media)
    const row = r.rows[1]
    // dot 60 -> byte 7 (60>>3=7), bit mask 1 << (7 - (60 & 7)) = 1 << (7-4) = 0x08
    expect(row[7]).toBe(0x08)
    // all other bytes zero
    expect(Array.from(row).filter((b, i) => i !== 7).every((b) => b === 0)).toBe(true)
  })

  it('throws when image height does not match printableDots', () => {
    expect(() => rgbaToRaster(img(2, 7, () => false), media)).toThrow()
  })
})
