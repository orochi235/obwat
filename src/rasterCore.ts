import type { RgbaImage, MediaSpec, Raster1bpp } from './types'

function isBlack(data: Uint8ClampedArray, i: number): boolean {
  const a = data[i + 3]
  if (a <= 127) return false
  const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
  return lum < 128
}

/**
 * Convert a landscape RGBA label render to a Brother raster.
 * Image width = label length in dots; image height MUST equal media.printableDots.
 * Each image column becomes one raster line (printer prints sideways).
 */
export function rgbaToRaster(image: RgbaImage, media: MediaSpec): Raster1bpp {
  if (image.height !== media.printableDots) {
    throw new Error(
      `image height ${image.height} must equal printableDots ${media.printableDots}`,
    )
  }
  const lineBytes = media.printheadDots / 8
  if (!Number.isInteger(lineBytes)) {
    throw new Error(`printheadDots ${media.printheadDots} must be a multiple of 8`)
  }
  const offset = Math.floor((media.printheadDots - media.printableDots) / 2)
  const rows: Uint8Array[] = []
  for (let x = 0; x < image.width; x++) {
    const row = new Uint8Array(lineBytes)
    for (let y = 0; y < image.height; y++) {
      const i = (y * image.width + x) * 4
      if (isBlack(image.data, i)) {
        const dot = offset + y
        row[dot >> 3] |= 1 << (7 - (dot & 7))
      }
    }
    rows.push(row)
  }
  return { lineBytes, lineCount: image.width, rows }
}
