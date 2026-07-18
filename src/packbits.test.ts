import { describe, it, expect } from 'vitest'
import { packbits } from './packbits'

const enc = (a: number[]) => Array.from(packbits(Uint8Array.from(a)))

describe('packbits', () => {
  it('encodes a single literal byte', () => {
    expect(enc([0x00])).toEqual([0x00, 0x00]) // control 0 (1 literal), data
  })
  it('encodes a literal run', () => {
    expect(enc([1, 2, 3])).toEqual([0x02, 1, 2, 3]) // control n-1=2, then 3 bytes
  })
  it('encodes a replicate run', () => {
    expect(enc([0xaa, 0xaa, 0xaa, 0xaa, 0xaa])).toEqual([0xfc, 0xaa]) // 257-5=0xFC
  })
  it('encodes mixed runs', () => {
    expect(enc([0xaa, 0xaa, 0xaa, 1, 2])).toEqual([0xfe, 0xaa, 0x01, 1, 2]) // rep3 then lit2
  })
  it('encodes empty input as empty', () => {
    expect(enc([])).toEqual([])
  })
})
