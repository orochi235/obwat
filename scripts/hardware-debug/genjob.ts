import { writeFileSync } from 'node:fs'
import { createBrotherRasterDriver } from '/Users/mike/src/lbx-editor/src/printing/brotherDriver'
import { ptP710btMedia } from '/Users/mike/src/lbx-editor/src/printing/profiles'
import { rgbaToRaster } from '/Users/mike/src/lbx-editor/src/printing/rasterCore'

const media = ptP710btMedia(12) // 12mm tape confirmed loaded -> printableDots 70
const width = 300 // dots along the tape (~42mm at 180dpi)
const height = media.printableDots
const data = new Uint8ClampedArray(width * height * 4)
data.fill(255) // opaque white

function setBlack(x: number, y: number) {
  const i = (y * width + x) * 4
  data[i] = 0; data[i + 1] = 0; data[i + 2] = 0; data[i + 3] = 255
}

// outlined rectangle, 6-dot border
for (let x = 40; x < 260; x++) {
  for (let y = 10; y < 60; y++) {
    if (x < 46 || x >= 254 || y < 16 || y >= 54) setBlack(x, y)
  }
}

const raster = rgbaToRaster({ width, height, data }, media)
const bytes = createBrotherRasterDriver().encode(raster, { tapeWidthMm: 12, autoCut: true, marginDots: 0 })
writeFileSync(new URL('./job.bin', import.meta.url).pathname, bytes)
console.log('job bytes:', bytes.length, 'raster lines:', raster.lineCount, 'printableDots:', height)
