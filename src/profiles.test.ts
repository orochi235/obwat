import { describe, it, expect } from 'vitest'
import { ptP710btMedia, PT_P710BT_DPI, PT_P710BT_PRINTHEAD_DOTS } from './profiles'

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
