import { describe, it, expect } from 'vitest'
import { ditherRgba, ditherToMask, type PixelRect } from './dither'
import { rgbaToRaster } from './rasterCore'
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

describe('protected regions', () => {
  /** Left half mid-gray (which every diffusing algorithm turns into a
   *  pattern), right half the same gray but declared off-limits. */
  function halfProtected(): { image: RgbaImage; protect: PixelRect[] } {
    return {
      image: gray(16, 8, 128),
      protect: [{ x: 8, y: 0, width: 8, height: 8 }],
    }
  }

  function region(mask: Uint8Array, width: number, r: PixelRect): number[] {
    const out: number[] = []
    for (let y = r.y; y < r.y + r.height; y++) {
      for (let x = r.x; x < r.x + r.width; x++) out.push(mask[y * width + x] ?? -1)
    }
    return out
  }

  const DITHERS = ['floyd-steinberg', 'atkinson', 'bayer'] as const

  it.each(DITHERS)('quantizes a protected region by threshold under %s', (algorithm) => {
    const { image, protect } = halfProtected()
    const mask = ditherToMask(image, { algorithm, protect })
    const plain = ditherToMask(image)

    // 128 is not < 128, so thresholding leaves the whole region white. The
    // point is that it matches the threshold pass and not the algorithm's.
    expect(region(mask, 16, protect[0]!)).toEqual(region(plain, 16, protect[0]!))
  })

  it.each(DITHERS)('still dithers everything outside the region under %s', (algorithm) => {
    const { image, protect } = halfProtected()
    const mask = ditherToMask(image, { algorithm, protect })
    const unprotected = { x: 0, y: 0, width: 8, height: 8 }

    // Mid-gray thresholds to solid white; a dithered half must not.
    expect(region(mask, 16, unprotected).some((v) => v === 1)).toBe(true)
  })

  it('does not let a neighbour diffuse error into the region', () => {
    // The left column is dark enough to emit error every row; without the
    // boundary stop it lands in the first protected column and flips pixels
    // the threshold pass would have left alone.
    const image = gray(8, 8, 128)
    for (let y = 0; y < 8; y++) {
      const i = (y * 8) * 4
      image.data[i] = 40
      image.data[i + 1] = 40
      image.data[i + 2] = 40
    }
    const protect: PixelRect[] = [{ x: 1, y: 0, width: 7, height: 8 }]

    const mask = ditherToMask(image, { algorithm: 'floyd-steinberg', protect })
    const plain = ditherToMask(image)

    expect(region(mask, 8, protect[0]!)).toEqual(region(plain, 8, protect[0]!))
  })

  it('rounds a fractional rect outward to whole pixels', () => {
    const image = gray(8, 1, 128)
    const mask = ditherToMask(image, {
      algorithm: 'floyd-steinberg',
      protect: [{ x: 2.4, y: 0, width: 1.2, height: 0.5 }],
    })
    const plain = ditherToMask(image)

    // Every pixel the rect touches — 2 and 3 — is thresholded.
    expect(mask[2]).toBe(plain[2])
    expect(mask[3]).toBe(plain[3])
  })

  it('clips a rect that runs past the image instead of throwing', () => {
    const image = gray(4, 4, 128)
    const mask = ditherToMask(image, {
      algorithm: 'floyd-steinberg',
      protect: [{ x: -10, y: -10, width: 100, height: 100 }],
    })

    expect(Array.from(mask)).toEqual(Array.from(ditherToMask(image)))
  })

  it('unions overlapping rects', () => {
    const image = gray(8, 1, 128)
    const mask = ditherToMask(image, {
      algorithm: 'floyd-steinberg',
      protect: [
        { x: 0, y: 0, width: 4, height: 1 },
        { x: 2, y: 0, width: 6, height: 1 },
      ],
    })

    expect(Array.from(mask)).toEqual(Array.from(ditherToMask(image)))
  })

  it('leaves output unchanged when no region is given', () => {
    // The regression guard: every existing caller passes no `protect`.
    const image = gray(16, 16, 128)
    for (const algorithm of DITHERS) {
      const before = ditherToMask(image, { algorithm })
      expect(Array.from(ditherToMask(image, { algorithm, protect: [] }))).toEqual(
        Array.from(before),
      )
      expect(Array.from(ditherToMask(image, { algorithm, protect: undefined }))).toEqual(
        Array.from(before),
      )
    }
  })

  it('reaches the raster through rgbaToRaster, not just the mask', () => {
    // rgbaToRaster forwards DitherOptions; this is what makes print and
    // preview share one setting instead of two code paths.
    const image = gray(16, 8, 128)
    const media = { dpi: 180, printheadDots: 128, printableDots: 8, tapeWidthMm: 24 }
    const protect: PixelRect[] = [{ x: 0, y: 0, width: 16, height: 8 }]

    const dithered = rgbaToRaster(image, media, { algorithm: 'floyd-steinberg' })
    const protectedRaster = rgbaToRaster(image, media, { algorithm: 'floyd-steinberg', protect })
    const thresholded = rgbaToRaster(image, media)

    expect(protectedRaster.rows).toEqual(thresholded.rows)
    expect(protectedRaster.rows).not.toEqual(dithered.rows)
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
