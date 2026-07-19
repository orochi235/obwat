import { describe, it, expect } from 'vitest'
import { ditherRgba, ditherToMask } from './dither'
import type { RgbaImage } from './types'

function gray(width: number, height: number, value: number, alpha = 255): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = value
    data[i * 4 + 1] = value
    data[i * 4 + 2] = value
    data[i * 4 + 3] = alpha
  }
  return { width, height, data }
}

function blackFraction(mask: Uint8Array): number {
  let n = 0
  for (const v of mask) n += v
  return n / mask.length
}

describe('ditherToMask', () => {
  describe('threshold', () => {
    it('maps dark pixels to black and light pixels to white at the default threshold', () => {
      expect(Array.from(ditherToMask(gray(2, 1, 100)))).toEqual([1, 1])
      expect(Array.from(ditherToMask(gray(2, 1, 200)))).toEqual([0, 0])
    })

    it('respects a custom threshold', () => {
      expect(Array.from(ditherToMask(gray(1, 1, 100), { threshold: 90 }))).toEqual([0])
      expect(Array.from(ditherToMask(gray(1, 1, 80), { threshold: 90 }))).toEqual([1])
    })

    it('treats transparent pixels as white even when the color is black', () => {
      expect(Array.from(ditherToMask(gray(1, 1, 0, 0)))).toEqual([0])
    })
  })

  describe('floyd-steinberg', () => {
    it('preserves the average tone of a mid-gray region', () => {
      const mask = ditherToMask(gray(32, 32, 128), { algorithm: 'floyd-steinberg' })
      const expected = 1 - 128 / 255
      expect(blackFraction(mask)).toBeGreaterThan(expected - 0.05)
      expect(blackFraction(mask)).toBeLessThan(expected + 0.05)
    })

    it('leaves pure black and pure white untouched', () => {
      expect(blackFraction(ditherToMask(gray(8, 8, 0), { algorithm: 'floyd-steinberg' }))).toBe(1)
      expect(blackFraction(ditherToMask(gray(8, 8, 255), { algorithm: 'floyd-steinberg' }))).toBe(0)
    })

    it('is deterministic', () => {
      const a = ditherToMask(gray(16, 16, 77), { algorithm: 'floyd-steinberg' })
      const b = ditherToMask(gray(16, 16, 77), { algorithm: 'floyd-steinberg' })
      expect(Array.from(a)).toEqual(Array.from(b))
    })
  })

  describe('atkinson', () => {
    it('approximates the average tone of a mid-gray region', () => {
      // Atkinson diffuses only 3/4 of the error, so tolerance is looser.
      const mask = ditherToMask(gray(32, 32, 128), { algorithm: 'atkinson' })
      const expected = 1 - 128 / 255
      expect(blackFraction(mask)).toBeGreaterThan(expected - 0.15)
      expect(blackFraction(mask)).toBeLessThan(expected + 0.15)
    })

    it('leaves pure black and pure white untouched', () => {
      expect(blackFraction(ditherToMask(gray(8, 8, 0), { algorithm: 'atkinson' }))).toBe(1)
      expect(blackFraction(ditherToMask(gray(8, 8, 255), { algorithm: 'atkinson' }))).toBe(0)
    })
  })

  describe('bayer', () => {
    it('produces the classic 4x4 ordered pattern for uniform gray', () => {
      // black iff gray < (m + 0.5) * 16, so for gray=100 cells with m >= 6 are black
      const mask = ditherToMask(gray(4, 4, 100), { algorithm: 'bayer' })
      const matrix = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]
      expect(Array.from(mask)).toEqual(matrix.map((m) => (m >= 6 ? 1 : 0)))
    })

    it('tiles the matrix across larger images', () => {
      const mask = ditherToMask(gray(8, 8, 100), { algorithm: 'bayer' })
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          expect(mask[y * 8 + x]).toBe(mask[(y % 4) * 8 + (x % 4)])
        }
      }
    })
  })
})

describe('ditherRgba', () => {
  it('returns a pure black/white opaque image of the same size', () => {
    const out = ditherRgba(gray(4, 4, 128), { algorithm: 'floyd-steinberg' })
    expect(out.width).toBe(4)
    expect(out.height).toBe(4)
    expect(out.data.length).toBe(4 * 4 * 4)
    for (let i = 0; i < 16; i++) {
      const [r, g, b, a] = [
        out.data[i * 4],
        out.data[i * 4 + 1],
        out.data[i * 4 + 2],
        out.data[i * 4 + 3],
      ]
      expect(a).toBe(255)
      expect(r === 0 || r === 255).toBe(true)
      expect(g).toBe(r)
      expect(b).toBe(r)
    }
  })

  it('matches ditherToMask pixel for pixel', () => {
    const img = gray(8, 8, 90)
    const mask = ditherToMask(img, { algorithm: 'bayer' })
    const out = ditherRgba(img, { algorithm: 'bayer' })
    for (let i = 0; i < mask.length; i++) {
      expect(out.data[i * 4]).toBe(mask[i] ? 0 : 255)
    }
  })
})
