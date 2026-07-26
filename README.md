# obwat

**"O Brother Where Art Thou"** — Brother P-touch raster printing from the
browser, over WebUSB (preferred) or Web Serial. No native drivers, no
middleware: pixels in, label out.

The package owns everything from pixels to paper: you hand it an `RgbaImage`,
it thresholds and packs the bits, encodes the PT raster command stream, and
ships it over the transport. Rendering the label (text, layout, scenes) is the
consumer's job.

## Browser support

**Chrome on desktop is the primary target** — it's what obwat is developed and
tested against. WebUSB and Web Serial are Chromium-only APIs (both require a
secure context: `https:` or `localhost`), which constrains the rest of the
field:

- **Other desktop Chromium browsers** (Edge, Opera, Vivaldi, Arc, …) ship the
  same engine and should work identically, but aren't regularly tested. Brave
  disables Web Serial by default; it must be enabled per-site.
- **Chrome on Android** has WebUSB but not Web Serial, so the WebUSB path may
  work with a USB OTG adapter — untested.
- **Firefox and Safari** implement neither API and have publicly declined to,
  so there is no support path. On iOS/iPadOS every browser uses WebKit, so
  nothing works there either.

## Quick start

```ts
import { createBrotherPrinter, rgbaToRaster, Printers, NoGrantedDeviceError } from 'obwat'

const printer = createBrotherPrinter()

// Inside a user gesture — shows the browser's device picker once:
await printer.requestDevice()

const raster = rgbaToRaster(image, Printers.ptP710bt.media(24))
try {
  const status = await printer.print(raster, {
    tapeWidthMm: 24,
    autoCut: true,
    marginDots: 0,
  })
} catch (e) {
  if (e instanceof NoGrantedDeviceError) {
    // No previously-granted device found — offer the picker, or hint that
    // the printer may be asleep.
  }
}
```

## Architecture

Two layers, both exported:

1. **Primitives** (à la carte)
   - `types` — the `RgbaImage` → `Raster1bpp` boundary, plus `Driver` /
     `Transport` / `DeviceProfile` interfaces
   - `rasterCore` — quantization + MSB-first bit packing (`rgbaToRaster`),
     plus `rasterToRgba` to render a packed raster back to an image for
     debugging (full printhead, centering offset included)
   - `dither` — RGBA → 1-bit quantization: `threshold` (default),
     `floyd-steinberg`, `atkinson`, `bayer` (4×4 ordered). `ditherRgba`
     returns a black/white `RgbaImage` preview that matches the print path
     exactly
   - `packbits` — PackBits run-length encoding
   - `brotherDriver` — PT raster command stream + status parsing
   - `webUsbTransport` / `webSerialTransport` — structural device interfaces
     (`UsbDeviceLike`, `SerialPortLike`), testable with fakes
   - `profiles` — the `Printers` registry: per-model geometry + `media()` /
     `profile()` factories (e.g. `Printers.ptP710bt.media(12)`)
   - `printJob` — `printRaster()`: one job over a driver + transport
   - `keepalive` — periodic status polling to hold off auto-sleep

2. **Facade** — `createBrotherPrinter()`, a *connectionless* session. Every
   operation acquires the device, claims the interface, works, and releases,
   serialized behind an internal mutex. There is no consumer-visible
   open/close: the printer auto-sleeps and vanishes from USB enumeration, so
   "connected" is never a stable state worth exposing. The facade owns device
   acquisition and keepalive, and emits `onStatus` updates after every print,
   poll, and keepalive tick. `queryMedia()` reports the loaded tape's
   `MediaSpec` (render height, dpi) so consumers know what geometry to
   produce; `mediaForStatus()` derives the same thing from any `onStatus`
   emission.

### Design rules

- **No UX policy.** No localStorage, no alerts, no copy. Consumers get typed
  errors (`NoGrantedDeviceError`) and decide what to show.
- **The app renders pixels; obwat prints them.** Label/scene rendering does
  not belong here.
- PT-P710BT is the only profile until real second-printer hardware exists.

### Dithering and resolution

The PT-P710BT prints at **180 dpi** with a 128-dot head (recorded as
`Printers.ptP710bt.dpi` / `.printheadDots`). `rgbaToRaster` requires the input image to
already be at the printer's native dot grid (height = `printableDots`) and
quantizes 1:1 — there is no resampling after dithering anywhere in the
pipeline, which is the main moiré hazard. Consumers must do any scaling
*before* handing pixels to obwat, and must never scale a dithered image.
Ordered (`bayer`) dithering can still interfere with periodic patterns in the
source art; use an error-diffusion algorithm (`floyd-steinberg`, `atkinson`)
when that matters.

```ts
import { ditherRgba, rgbaToRaster, rasterToRgba } from 'obwat'

const preview = ditherRgba(image, { algorithm: 'atkinson' })       // B/W RgbaImage
const raster = rgbaToRaster(image, media, { algorithm: 'atkinson' }) // same pixels, packed
const printed = rasterToRgba(raster)                                // virtual-printer view
```

Not all artwork on a label wants dithering. Where the geometry *is* the
meaning — a barcode, a hairline rule, small type — a dither pattern is damage
rather than tone: error diffusion carries a bar edge's quantization error into
the bar beside it, and an ordered matrix resolves the same edge black on one
row and white on the next. `protect` names those regions, in image pixels:

```ts
const raster = rgbaToRaster(image, media, {
  algorithm: 'atkinson',
  protect: [{ x: 40, y: 8, width: 96, height: 48 }], // barcode + quiet zone
})
```

Protected pixels quantize at the flat `threshold`, and error diffusion stops
at the boundary in both directions — so the photograph beside them still
dithers, without pushing a speck into the quiet zone. obwat asks no questions
about what a region contains; the consumer knows which of its objects can't
survive a dither.

## Hardware notes

- Supported/tested: **Brother PT-P710BT**. `docs/hardware/pt-p710bt.md` is the
  canonical hardware/OS reference; `scripts/hardware-debug/` holds one-off
  probe tools.
- The printer auto-powers off after ~10 minutes idle and disappears from USB
  enumeration. An empty `getDevices()` usually means *asleep*, not a bug.

## Development

```sh
npm install
npm test        # vitest — all logic testable with fakes, no hardware needed
npm run build   # tsc → dist/
```

## License

MIT
