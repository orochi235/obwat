import type { RgbaImage, MediaSpec, Raster1bpp } from './types'
import { ditherToMask, type DitherOptions } from './dither'

/**
 * Convert a landscape RGBA label render to a Brother raster.
 * Image width = label length in dots; image height MUST equal media.printableDots.
 * Each image column becomes one raster line (printer prints sideways).
 *
 * Quantization is 1:1 on the printer's dot grid — dither here, never scale a
 * dithered image.
 */
export function rgbaToRaster(
  image: RgbaImage,
  media: MediaSpec,
  options: DitherOptions = {},
): Raster1bpp {
  if (image.height !== media.printableDots) {
    throw new Error(
      `image height ${image.height} must equal printableDots ${media.printableDots}`,
    )
  }
  const lineBytes = media.printheadDots / 8
  if (!Number.isInteger(lineBytes)) {
    throw new Error(`printheadDots ${media.printheadDots} must be a multiple of 8`)
  }
  const mask = ditherToMask(image, options)
  const offset = Math.floor((media.printheadDots - media.printableDots) / 2)
  const rows: Uint8Array[] = []
  for (let x = 0; x < image.width; x++) {
    const row = new Uint8Array(lineBytes)
    for (let y = 0; y < image.height; y++) {
      if (mask[y * image.width + x]) {
        const dot = offset + y
        const byte = dot >> 3
        row[byte] = (row[byte] ?? 0) | (1 << (7 - (dot & 7)))
      }
    }
    rows.push(row)
  }
  return { lineBytes, lineCount: image.width, rows }
}

/**
 * Render a packed raster back to a black/white RGBA image, one pixel per
 * printhead dot across the FULL head (height = lineBytes * 8), landscape
 * orientation like the rgbaToRaster input. Debug/preview surface: this is
 * exactly what the printer will lay down, centering offset included.
 */
export function rasterToRgba(raster: Raster1bpp): RgbaImage {
  const width = raster.lineCount
  const height = raster.lineBytes * 8
  const data = new Uint8ClampedArray(width * height * 4)
  for (let x = 0; x < width; x++) {
    const row = raster.rows[x]
    for (let y = 0; y < height; y++) {
      const bit = row ? ((row[y >> 3] ?? 0) >> (7 - (y & 7))) & 1 : 0
      const v = bit ? 0 : 255
      const i = (y * width + x) * 4
      data[i] = v
      data[i + 1] = v
      data[i + 2] = v
      data[i + 3] = 255
    }
  }
  return { width, height, data }
}
