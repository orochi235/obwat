/**
 * TIFF/PackBits run-length encoding, as expected by the Brother raster protocol.
 * Literal run of n (1..128): control byte (n-1), then n data bytes.
 * Replicate run of n (2..128): control byte (257-n), then 1 data byte.
 */
export function packbits(input: Uint8Array): Uint8Array {
  const out: number[] = []
  let i = 0
  const n = input.length
  while (i < n) {
    // measure a run of identical bytes starting at i
    let run = 1
    while (i + run < n && input[i + run] === input[i] && run < 128) run++

    if (run >= 2) {
      out.push(257 - run, input[i])
      i += run
    } else {
      // gather a literal run until the next >=2 repeat (or cap at 128)
      const start = i
      let lit = 1
      i++
      while (i < n && lit < 128) {
        const repeatAhead = i + 1 < n && input[i + 1] === input[i]
        if (repeatAhead) break
        lit++
        i++
      }
      out.push(lit - 1)
      for (let k = 0; k < lit; k++) out.push(input[start + k])
    }
  }
  return Uint8Array.from(out)
}
