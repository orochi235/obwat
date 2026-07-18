import type { DeviceProfile, MediaSpec, Transport } from './types'
import { createBrotherRasterDriver } from './brotherDriver'

export const PT_P710BT_DPI = 180
export const PT_P710BT_PRINTHEAD_DOTS = 128

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

/** Build the media spec for a given tape width (mm) on the PT-P710BT. */
export function ptP710btMedia(tapeWidthMm: number): MediaSpec {
  const printableDots =
    PT_P710BT_PRINTABLE_DOTS[tapeWidthMm] ??
    Math.min(PT_P710BT_PRINTHEAD_DOTS, Math.round((tapeWidthMm / 25.4) * PT_P710BT_DPI))
  return { dpi: PT_P710BT_DPI, printheadDots: PT_P710BT_PRINTHEAD_DOTS, printableDots, tapeWidthMm }
}

/** A PT-P710BT profile bound to an already-constructed transport (USB, serial, …). */
export function ptP710btProfile(transport: Transport, tapeWidthMm: number): DeviceProfile {
  return {
    model: 'Brother PT-P710BT',
    media: ptP710btMedia(tapeWidthMm),
    makeDriver: () => createBrotherRasterDriver(),
    makeTransport: () => transport,
  }
}
