import type { RgbaImage } from './types'

export type DitherAlgorithm = 'threshold' | 'floyd-steinberg' | 'atkinson' | 'bayer'

export interface DitherOptions {
  /** Default 'threshold' (the historical rgbaToRaster behavior). */
  algorithm?: DitherAlgorithm
  /** Quantization midpoint 0-255 (default 128): gray below it prints black. */
  threshold?: number
}

/**
 * Luminance composited over white (labels are white tape), so transparency
 * lightens toward white instead of being a special case.
 */
function toGray(image: RgbaImage): Float32Array {
  const n = image.width * image.height
  const gray = new Float32Array(n)
  const d = image.data
  for (let i = 0; i < n; i++) {
    const a = (d[i * 4 + 3] ?? 0) / 255
    const lum = 0.299 * (d[i * 4] ?? 0) + 0.587 * (d[i * 4 + 1] ?? 0) + 0.114 * (d[i * 4 + 2] ?? 0)
    gray[i] = lum * a + 255 * (1 - a)
  }
  return gray
}

// Classic 4x4 Bayer index matrix.
const BAYER_4X4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]

/**
 * Error-diffusion kernel entries as [dx, dy, weight-numerator]; denominator
 * passed separately.
 */
const FLOYD_STEINBERG: Array<[number, number, number]> = [
  [1, 0, 7],
  [-1, 1, 3],
  [0, 1, 5],
  [1, 1, 1],
]

const ATKINSON: Array<[number, number, number]> = [
  [1, 0, 1],
  [2, 0, 1],
  [-1, 1, 1],
  [0, 1, 1],
  [1, 1, 1],
  [0, 2, 1],
]

function diffuse(
  gray: Float32Array,
  width: number,
  height: number,
  threshold: number,
  kernel: Array<[number, number, number]>,
  denominator: number,
): Uint8Array {
  const mask = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      const old = gray[i] ?? 0
      const black = old < threshold
      mask[i] = black ? 1 : 0
      const err = old - (black ? 0 : 255)
      for (const [dx, dy, w] of kernel) {
        const nx = x + dx
        const ny = y + dy
        if (nx < 0 || nx >= width || ny >= height) continue
        const ni = ny * width + nx
        gray[ni] = (gray[ni] ?? 0) + (err * w) / denominator
      }
    }
  }
  return mask
}

/**
 * Quantize an RGBA image to a per-pixel black mask (1 = black) using the
 * selected dithering algorithm. Runs in image orientation; rgbaToRaster
 * rotates into printer raster lines afterward.
 */
export function ditherToMask(image: RgbaImage, options: DitherOptions = {}): Uint8Array {
  const { algorithm = 'threshold', threshold = 128 } = options
  const { width, height } = image
  const gray = toGray(image)

  switch (algorithm) {
    case 'threshold': {
      const mask = new Uint8Array(width * height)
      for (let i = 0; i < mask.length; i++) mask[i] = (gray[i] ?? 0) < threshold ? 1 : 0
      return mask
    }
    case 'bayer': {
      const mask = new Uint8Array(width * height)
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const m = BAYER_4X4[(y % 4) * 4 + (x % 4)] ?? 0
          const cell = (m + 0.5) * 16 + (threshold - 128)
          mask[y * width + x] = (gray[y * width + x] ?? 0) < cell ? 1 : 0
        }
      }
      return mask
    }
    case 'floyd-steinberg':
      return diffuse(gray, width, height, threshold, FLOYD_STEINBERG, 16)
    case 'atkinson':
      return diffuse(gray, width, height, threshold, ATKINSON, 8)
  }
}

/**
 * Dither to a pure black/white opaque RGBA image of the same dimensions.
 * Debug/preview surface: what you see is exactly what rgbaToRaster will pack.
 */
export function ditherRgba(image: RgbaImage, options: DitherOptions = {}): RgbaImage {
  const mask = ditherToMask(image, options)
  const data = new Uint8ClampedArray(image.width * image.height * 4)
  for (let i = 0; i < mask.length; i++) {
    const v = mask[i] ? 0 : 255
    data[i * 4] = v
    data[i * 4 + 1] = v
    data[i * 4 + 2] = v
    data[i * 4 + 3] = 255
  }
  return { width: image.width, height: image.height, data }
}
