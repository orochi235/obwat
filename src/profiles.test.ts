import { describe, it, expect } from 'vitest'
import {
  ptP710btMedia,
  ptP710btProfile,
  mediaForStatus,
  PT_P710BT_DPI,
  PT_P710BT_PRINTHEAD_DOTS,
} from './profiles'
import type { PrinterStatus } from './types'

describe('ptP710btProfile', () => {
  it('bundles model, media geometry, and a driver factory — no transport', () => {
    const profile = ptP710btProfile(12)
    expect(profile.model).toBe('Brother PT-P710BT')
    expect(profile.media.printableDots).toBe(70)
    expect(typeof profile.makeDriver().encode).toBe('function')
    expect('makeTransport' in profile).toBe(false)
  })
})

describe('ptP710btMedia', () => {
  it('12mm tape uses the documented print area (70 dots)', () => {
    expect(ptP710btMedia(12).printableDots).toBe(70)
  })

  it('24mm tape uses the documented print area (128 dots)', () => {
    expect(ptP710btMedia(24).printableDots).toBe(128)
  })

  it('18mm tape uses the documented print area (112 dots)', () => {
    expect(ptP710btMedia(18).printableDots).toBe(112)
  })

  it('falls back to the clamped formula for an unlisted width (10mm)', () => {
    expect(ptP710btMedia(10).printableDots).toBe(71)
  })

  it('passes through dpi, printheadDots, and tapeWidthMm', () => {
    const media = ptP710btMedia(12)
    expect(media.dpi).toBe(PT_P710BT_DPI)
    expect(media.printheadDots).toBe(PT_P710BT_PRINTHEAD_DOTS)
    expect(media.tapeWidthMm).toBe(12)
  })
})

function status(mediaWidthMm: number | null): PrinterStatus {
  return { raw: new Uint8Array(32), hasError: false, incomplete: false, mediaWidthMm }
}

describe('mediaForStatus', () => {
  it('maps a status with a known tape width to its media spec', () => {
    expect(mediaForStatus(status(12))).toEqual(ptP710btMedia(12))
  })

  it('returns null when the status has no media width', () => {
    expect(mediaForStatus(status(null))).toBeNull()
  })

  it('returns null when no tape is loaded (width 0)', () => {
    expect(mediaForStatus(status(0))).toBeNull()
  })
})
