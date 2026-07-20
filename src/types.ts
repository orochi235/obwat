/** A plain RGBA bitmap — no DOM dependency, so the raster core is testable in Node. */
export interface RgbaImage {
  width: number
  height: number
  data: Uint8ClampedArray // length === width * height * 4, RGBA
}

/** Physical printer geometry for a loaded medium. */
export interface MediaSpec {
  dpi: number
  printheadDots: number // total dots across the head (128 for PT-P710BT)
  printableDots: number // dots actually printed for this tape, centered in the head
  tapeWidthMm: number
}

/** Monochrome raster ready for a driver: one fixed-width row per printer raster line. */
export interface Raster1bpp {
  lineBytes: number // bytes per row (16 for PT-P710BT)
  lineCount: number // number of raster lines (label length in dots)
  rows: Uint8Array[] // each row is lineBytes long, MSB-first (bit 7 of byte 0 = dot 0)
}

export interface JobOptions {
  tapeWidthMm: number
  autoCut: boolean
  marginDots: number
}

/** Cassette media type (status byte 11). */
export type MediaType =
  | 'no-media'
  | 'laminated'
  | 'non-laminated'
  | 'heat-shrink-2-1'
  | 'heat-shrink-3-1'
  | 'incompatible'
  | 'unknown'

/** Cassette tape (background) color (status byte 24). */
export type TapeColor =
  | 'white'
  | 'other'
  | 'clear'
  | 'red'
  | 'blue'
  | 'yellow'
  | 'green'
  | 'black'
  | 'clear-white-text'
  | 'matte-white'
  | 'matte-clear'
  | 'matte-silver'
  | 'satin-gold'
  | 'satin-silver'
  | 'blue-d'
  | 'red-d'
  | 'fluorescent-orange'
  | 'fluorescent-yellow'
  | 'berry-pink-s'
  | 'light-gray-s'
  | 'lime-green-s'
  | 'yellow-f'
  | 'pink-f'
  | 'blue-f'
  | 'white-heat-shrink'
  | 'white-flex-id'
  | 'yellow-flex-id'
  | 'cleaning'
  | 'stencil'
  | 'incompatible'
  | 'unknown'

/** Cassette text (foreground/ink) color (status byte 25). */
export type TextColor =
  | 'white'
  | 'other'
  | 'red'
  | 'blue'
  | 'black'
  | 'gold'
  | 'blue-f'
  | 'cleaning'
  | 'stencil'
  | 'incompatible'
  | 'unknown'

/**
 * Parsed printer status reply. Cassette fields are null when the reply is
 * incomplete, 'unknown' when the byte carries a code the spec doesn't list
 * (the raw bytes are always available in `raw`).
 */
export interface PrinterStatus {
  raw: Uint8Array
  hasError: boolean
  /** True when fewer bytes than a full status reply arrived (timeout/disconnect). */
  incomplete: boolean
  /** Loaded tape width in mm (byte 10), or null when the reply is incomplete. */
  mediaWidthMm: number | null
  /** Cassette media type (byte 11). */
  mediaType: MediaType | null
  /** Tape background color (byte 24). */
  tapeColor: TapeColor | null
  /** Text/ink color (byte 25). */
  textColor: TextColor | null
}

export interface Driver {
  /** Encode a single-page job. Equivalent to `encodeJob([raster], opts)`. */
  encode(raster: Raster1bpp, opts: JobOptions): Uint8Array
  /** Encode a multi-page job: one label strip, the cutter firing between
   *  pages (auto-cut) and a feed after the last. Throws on an empty list. */
  encodeJob(pages: readonly Raster1bpp[], opts: JobOptions): Uint8Array
  parseStatus(raw: Uint8Array): PrinterStatus
}

export interface Transport {
  open(): Promise<void>
  write(bytes: Uint8Array): Promise<void>
  /**
   * Reads accumulated incoming chunks until at least `minBytes` bytes (default 1) have arrived
   * or `timeoutMs` elapses, then returns whatever was collected.
   * Note: read() cancels the underlying stream, so it is single-use per open() in Web Serial implementations.
   */
  read(timeoutMs: number, minBytes?: number): Promise<Uint8Array>
  close(): Promise<void>
}

export interface DeviceProfile {
  model: string
  media: MediaSpec
  makeDriver(): Driver
}
