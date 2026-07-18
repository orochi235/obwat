import { describe, it, expect } from 'vitest'
import type { RgbaImage } from './types'

describe('printing module', () => {
  it('types are importable and test runner works', () => {
    const img: RgbaImage = { width: 1, height: 1, data: new Uint8ClampedArray(4) }
    expect(img.data.length).toBe(4)
  })
})
