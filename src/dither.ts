import type { RgbaImage } from './types'

export type DitherAlgorithm = 'threshold' | 'floyd-steinberg' | 'atkinson' | 'bayer'

/**
 * A rectangle of image pixels, in the dither's own orientation — the same
 * space as `RgbaImage`, before `rgbaToRaster` rotates into raster lines.
 */
export interface PixelRect {
  x: number
  y: number
  width: number
  height: number
}

export interface DitherOptions {
  /** Default 'threshold' (the historical rgbaToRaster behavior). */
  algorithm?: DitherAlgorithm
  /** Quantization midpoint 0-255 (default 128): gray below it prints black. */
  threshold?: number
  /**
   * Regions that must come out of the quantizer exactly as `threshold` would
   * render them, whatever `algorithm` says — artwork whose geometry carries
   * the meaning, where a dither pattern is damage rather than tone. A caller
   * that mixes a photograph with a barcode, a hairline rule, or small type
   * wants the photograph dithered and those left alone.
   *
   * Inside a rect, pixels quantize at `threshold`. Error diffusion stops at
   * the boundary in both directions: error from outside is dropped rather
   * than landing in the region, and protected pixels contribute none of their
   * own. Stopping it at the edge is the point — quantizing the region
   * separately and pasting it back would still leave the specks the diffuser
   * pushed into the surrounding whitespace.
   *
   * Rects round outward to whole pixels and clip to the image, so a
   * fractional rect covers every pixel it touches. Absent or empty, output is
   * unchanged.
   */
  protect?: readonly PixelRect[]
}

/**
 * Flatten protected rects into a per-pixel lookup, or null when there are
 * none — which keeps the unprotected path free of per-pixel checks.
 */
function protectionMask(
  rects: readonly PixelRect[] | undefined,
  width: number,
  height: number,
): Uint8Array | null {
  if (!rects || rects.length === 0) return null
  const mask = new Uint8Array(width * height)
  for (const r of rects) {
    const x0 = Math.max(0, Math.floor(r.x))
    const y0 = Math.max(0, Math.floor(r.y))
    const x1 = Math.min(width, Math.ceil(r.x + r.width))
    const y1 = Math.min(height, Math.ceil(r.y + r.height))
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) mask[y * width + x] = 1
    }
  }
  return mask
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
  protectedPx: Uint8Array | null,
): Uint8Array {
  const mask = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      const old = gray[i] ?? 0
      const black = old < threshold
      mask[i] = black ? 1 : 0
      // A protected pixel still quantizes — at the plain threshold, against a
      // value nothing has diffused into — but emits no error of its own.
      if (protectedPx?.[i]) continue
      const err = old - (black ? 0 : 255)
      for (const [dx, dy, w] of kernel) {
        const nx = x + dx
        const ny = y + dy
        if (nx < 0 || nx >= width || ny >= height) continue
        const ni = ny * width + nx
        if (protectedPx?.[ni]) continue
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
  // Threshold is already what protection asks for, so it needs no lookup.
  const protectedPx =
    algorithm === 'threshold' ? null : protectionMask(options.protect, width, height)

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
          const i = y * width + x
          const m = BAYER_4X4[(y % 4) * 4 + (x % 4)] ?? 0
          // Protected pixels take the flat midpoint instead of the matrix's
          // per-pixel one: an ordered threshold is what makes one edge
          // resolve black on one row and white on the next.
          const cell = protectedPx?.[i] ? threshold : (m + 0.5) * 16 + (threshold - 128)
          mask[i] = (gray[i] ?? 0) < cell ? 1 : 0
        }
      }
      return mask
    }
    case 'floyd-steinberg':
      return diffuse(gray, width, height, threshold, FLOYD_STEINBERG, 16, protectedPx)
    case 'atkinson':
      return diffuse(gray, width, height, threshold, ATKINSON, 8, protectedPx)
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
