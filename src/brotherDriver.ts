import type { Driver, MediaType, Raster1bpp, JobOptions, PrinterStatus, TapeColor, TextColor } from './types'
import { packbits } from './packbits'

// Code tables from the Brother raster command reference (PT-E550W/P750W/P710BT).
const MEDIA_TYPES: Record<number, MediaType> = {
  0x00: 'no-media',
  0x01: 'laminated',
  0x03: 'non-laminated',
  0x11: 'heat-shrink-2-1',
  0x17: 'heat-shrink-3-1',
  0xff: 'incompatible',
}

const TAPE_COLORS: Record<number, TapeColor> = {
  0x01: 'white',
  0x02: 'other',
  0x03: 'clear',
  0x04: 'red',
  0x05: 'blue',
  0x06: 'yellow',
  0x07: 'green',
  0x08: 'black',
  0x09: 'clear-white-text',
  0x20: 'matte-white',
  0x21: 'matte-clear',
  0x22: 'matte-silver',
  0x23: 'satin-gold',
  0x24: 'satin-silver',
  0x30: 'blue-d',
  0x31: 'red-d',
  0x40: 'fluorescent-orange',
  0x41: 'fluorescent-yellow',
  0x50: 'berry-pink-s',
  0x51: 'light-gray-s',
  0x52: 'lime-green-s',
  0x60: 'yellow-f',
  0x61: 'pink-f',
  0x62: 'blue-f',
  0x70: 'white-heat-shrink',
  0x90: 'white-flex-id',
  0x91: 'yellow-flex-id',
  0xf0: 'cleaning',
  0xf1: 'stencil',
  0xff: 'incompatible',
}

const TEXT_COLORS: Record<number, TextColor> = {
  0x01: 'white',
  0x02: 'other',
  0x04: 'red',
  0x05: 'blue',
  0x08: 'black',
  0x0a: 'gold',
  0x62: 'blue-f',
  0xf0: 'cleaning',
  0xf1: 'stencil',
  0xff: 'incompatible',
}

function isBlankRow(row: Uint8Array): boolean {
  for (let i = 0; i < row.length; i++) if (row[i] !== 0) return false
  return true
}

/** Stand-alone status query: 100-byte invalidate + initialize (ESC @) + status request (ESC i S). */
export function encodeStatusRequest(): Uint8Array {
  const out = new Uint8Array(105)
  out.set([0x1b, 0x40, 0x1b, 0x69, 0x53], 100)
  return out
}

/** Brother PT-P710BT raster driver. Byte sequence taken verbatim from the reference impl. */
export function createBrotherRasterDriver(): Driver {
  return {
    encode(raster: Raster1bpp, opts: JobOptions): Uint8Array {
      const out: number[] = []

      // 1. invalidate
      for (let i = 0; i < 100; i++) out.push(0x00)
      // 2. initialize
      out.push(0x1b, 0x40)
      // 3. status request
      out.push(0x1b, 0x69, 0x53)
      // 4. raster mode
      out.push(0x1b, 0x69, 0x61, 0x01)
      // 4.5. switch automatic status notification mode: notify (default)
      out.push(0x1b, 0x69, 0x21, 0x00)
      // 5. print information: ESC i z, flags 0x84, media 0x00, width mm, length 0x00,
      //    raster count (4-byte LE), trailing 0x00 0x00
      const n = raster.lineCount
      out.push(
        0x1b, 0x69, 0x7a, 0x84, 0x00, opts.tapeWidthMm & 0xff, 0x00,
        n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff,
        0x00, 0x00,
      )
      // 6. various mode: auto-cut bit (0x40)
      out.push(0x1b, 0x69, 0x4d, opts.autoCut ? 0x40 : 0x00)
      // 7. advanced mode
      out.push(0x1b, 0x69, 0x4b, 0x08)
      // 8. margin (2-byte LE)
      out.push(0x1b, 0x69, 0x64, opts.marginDots & 0xff, (opts.marginDots >> 8) & 0xff)
      // 9. compression mode: TIFF/PackBits
      out.push(0x4d, 0x02)
      // 10. raster data
      for (const row of raster.rows) {
        if (isBlankRow(row)) {
          out.push(0x5a)
        } else {
          const packed = packbits(row)
          out.push(0x47, packed.length & 0xff, (packed.length >> 8) & 0xff)
          for (const b of packed) out.push(b)
        }
      }
      // 11. print + feed + cut
      out.push(0x1a)

      return Uint8Array.from(out)
    },

    parseStatus(raw: Uint8Array): PrinterStatus {
      // Brother 32-byte status: error-information bytes at offsets 8 and 9.
      const hasError = raw.length >= 10 && (raw[8] !== 0 || raw[9] !== 0)
      // Full Brother status is 32 bytes; fewer means a timeout/disconnect truncated it.
      const incomplete = raw.length < 32
      const mediaWidthMm = incomplete ? null : (raw[10] ?? null)
      const mediaType = incomplete ? null : (MEDIA_TYPES[raw[11] ?? -1] ?? 'unknown')
      const tapeColor = incomplete ? null : (TAPE_COLORS[raw[24] ?? -1] ?? 'unknown')
      const textColor = incomplete ? null : (TEXT_COLORS[raw[25] ?? -1] ?? 'unknown')
      return { raw, hasError, incomplete, mediaWidthMm, mediaType, tapeColor, textColor }
    },
  }
}
