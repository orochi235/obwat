import { describe, it, expect } from 'vitest'
import { rgbaToRaster, rasterToRgba } from './rasterCore'
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

  it('accepts dither options and applies them to the packed output', () => {
    // Uniform gray 200: plain threshold prints nothing, bayer prints some dots.
    const grayImg: RgbaImage = {
      width: 8,
      height: 8,
      data: new Uint8ClampedArray(
        Array.from({ length: 8 * 8 }, () => [200, 200, 200, 255]).flat(),
      ),
    }
    const plain = rgbaToRaster(grayImg, media)
    const dithered = rgbaToRaster(grayImg, media, { algorithm: 'bayer' })
    const dots = (r: ReturnType<typeof rgbaToRaster>) =>
      r.rows.reduce((n, row) => n + row.reduce((m, b) => m + popcount(b), 0), 0)
    expect(dots(plain)).toBe(0)
    expect(dots(dithered)).toBeGreaterThan(0)
  })
})

function popcount(byte: number): number {
  let n = 0
  for (let b = byte; b > 0; b >>= 1) n += b & 1
  return n
}

describe('rasterToRgba', () => {
  it('renders the full printhead so centering is visible', () => {
    const r = rgbaToRaster(img(3, 8, (x, y) => x === 1 && y === 0), media)
    const out = rasterToRgba(r)
    expect(out.width).toBe(3)
    expect(out.height).toBe(128)
    // The black pixel at (1, 0) landed on dot 60 (centered offset), so the
    // rendered image is black at (x=1, y=60) and white elsewhere.
    for (let y = 0; y < 128; y++) {
      for (let x = 0; x < 3; x++) {
        const i = (y * 3 + x) * 4
        const expected = x === 1 && y === 60 ? 0 : 255
        expect(out.data[i]).toBe(expected)
        expect(out.data[i + 3]).toBe(255)
      }
    }
  })
})
