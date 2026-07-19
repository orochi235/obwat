import type { DeviceProfile, MediaSpec, PrinterStatus } from './types'
import { createBrotherRasterDriver } from './brotherDriver'

/** A supported printer model: fixed geometry plus per-tape-width factories. */
export interface PrinterDefinition {
  model: string
  dpi: number
  printheadDots: number
  /** Media spec for a given tape width (mm). */
  media(tapeWidthMm: number): MediaSpec
  /** Full profile (geometry + driver factory) for a given tape width (mm). */
  profile(tapeWidthMm: number): DeviceProfile
}

const PT_P710BT_DPI = 180
const PT_P710BT_PRINTHEAD_DOTS = 128

/**
 * Documented print-area dot counts per tape width (PT-P700-series raster reference).
 * The printer reserves top/bottom margins, so these are smaller than the physical
 * tape width in dots. TODO(task8): confirm against hardware.
 */
const PT_P710BT_PRINTABLE_DOTS: Record<number, number> = {
  3.5: 24,
  6: 32,
  9: 50,
  12: 70,
  18: 112,
  24: 128,
}

function ptP710btMedia(tapeWidthMm: number): MediaSpec {
  const printableDots =
    PT_P710BT_PRINTABLE_DOTS[tapeWidthMm] ??
    Math.min(PT_P710BT_PRINTHEAD_DOTS, Math.round((tapeWidthMm / 25.4) * PT_P710BT_DPI))
  return { dpi: PT_P710BT_DPI, printheadDots: PT_P710BT_PRINTHEAD_DOTS, printableDots, tapeWidthMm }
}

/** Every supported printer, keyed by model. PT-P710BT is the only one until real second-printer hardware exists. */
export const Printers = {
  ptP710bt: {
    model: 'Brother PT-P710BT',
    dpi: PT_P710BT_DPI,
    printheadDots: PT_P710BT_PRINTHEAD_DOTS,
    media: ptP710btMedia,
    profile: (tapeWidthMm: number): DeviceProfile => ({
      model: 'Brother PT-P710BT',
      media: ptP710btMedia(tapeWidthMm),
      makeDriver: () => createBrotherRasterDriver(),
    }),
  },
} satisfies Record<string, PrinterDefinition>

/**
 * Media spec for whatever tape a status reply says is loaded, or null when the
 * status carries no usable width (incomplete reply, or no tape). Lets onStatus
 * consumers derive render geometry from every emission.
 */
export function mediaForStatus(status: PrinterStatus): MediaSpec | null {
  if (!status.mediaWidthMm) return null
  return Printers.ptP710bt.media(status.mediaWidthMm)
}
