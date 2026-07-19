import { describe, it, expect } from 'vitest'
import { Printers, mediaForStatus } from './profiles'
import type { PrinterStatus } from './types'

describe('Printers', () => {
  it('exposes the PT-P710BT definition with geometry and factories', () => {
    const p = Printers.ptP710bt
    expect(p.model).toBe('Brother PT-P710BT')
    expect(p.dpi).toBe(180)
    expect(p.printheadDots).toBe(128)
  })

  it('profile() bundles model, media geometry, and a driver factory — no transport', () => {
    const profile = Printers.ptP710bt.profile(12)
    expect(profile.model).toBe('Brother PT-P710BT')
    expect(profile.media.printableDots).toBe(70)
    expect(typeof profile.makeDriver().encode).toBe('function')
    expect('makeTransport' in profile).toBe(false)
  })
})

describe('Printers.ptP710bt.media', () => {
  const { media } = Printers.ptP710bt

  it('12mm tape uses the documented print area (70 dots)', () => {
    expect(media(12).printableDots).toBe(70)
  })

  it('24mm tape uses the documented print area (128 dots)', () => {
    expect(media(24).printableDots).toBe(128)
  })

  it('18mm tape uses the documented print area (112 dots)', () => {
    expect(media(18).printableDots).toBe(112)
  })

  it('falls back to the clamped formula for an unlisted width (10mm)', () => {
    expect(media(10).printableDots).toBe(71)
  })

  it('passes through dpi, printheadDots, and tapeWidthMm', () => {
    const spec = media(12)
    expect(spec.dpi).toBe(Printers.ptP710bt.dpi)
    expect(spec.printheadDots).toBe(Printers.ptP710bt.printheadDots)
    expect(spec.tapeWidthMm).toBe(12)
  })
})

function status(mediaWidthMm: number | null): PrinterStatus {
  return { raw: new Uint8Array(32), hasError: false, incomplete: false, mediaWidthMm }
}

describe('mediaForStatus', () => {
  it('maps a status with a known tape width to its media spec', () => {
    expect(mediaForStatus(status(12))).toEqual(Printers.ptP710bt.media(12))
  })

  it('returns null when the status has no media width', () => {
    expect(mediaForStatus(status(null))).toBeNull()
  })

  it('returns null when no tape is loaded (width 0)', () => {
    expect(mediaForStatus(status(0))).toBeNull()
  })
})
