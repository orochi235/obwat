# obwat

**"O Brother Where Art Thou"** — Brother P-touch raster printing from the
browser, over WebUSB (preferred) or Web Serial. No native drivers, no
middleware: pixels in, label out.

The package owns everything from pixels to paper: you hand it an `RgbaImage`,
it thresholds and packs the bits, encodes the PT raster command stream, and
ships it over the transport. Rendering the label (text, layout, scenes) is the
consumer's job.

## Quick start

```ts
import { createBrotherPrinter, rgbaToRaster, ptP710btMedia, NoGrantedDeviceError } from 'obwat'

const printer = createBrotherPrinter()

// Inside a user gesture — shows the browser's device picker once:
await printer.requestDevice()

const raster = rgbaToRaster(image, ptP710btMedia)
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
   - `rasterCore` — threshold + MSB-first bit packing
   - `packbits` — PackBits run-length encoding
   - `brotherDriver` — PT raster command stream + status parsing
   - `webUsbTransport` / `webSerialTransport` — structural device interfaces
     (`UsbDeviceLike`, `SerialPortLike`), testable with fakes
   - `profiles` — media geometry per printer model
   - `printJob` — `printRaster()`: one job over a driver + transport
   - `keepalive` — periodic status polling to hold off auto-sleep

2. **Facade** — `createBrotherPrinter()`, a *connectionless* session. Every
   operation acquires the device, claims the interface, works, and releases,
   serialized behind an internal mutex. There is no consumer-visible
   open/close: the printer auto-sleeps and vanishes from USB enumeration, so
   "connected" is never a stable state worth exposing. The facade owns device
   acquisition and keepalive, and emits `onStatus` updates after every print,
   poll, and keepalive tick.

### Design rules

- **No UX policy.** No localStorage, no alerts, no copy. Consumers get typed
  errors (`NoGrantedDeviceError`) and decide what to show.
- **The app renders pixels; obwat prints them.** Label/scene rendering does
  not belong here.
- PT-P710BT is the only profile until real second-printer hardware exists.

## Hardware notes

- Supported/tested: **Brother PT-P710BT**. `docs/hardware/pt-p710bt.md` is the
  canonical hardware/OS reference; `scripts/hardware-debug/` holds one-off
  probe tools.
- The printer auto-powers off after ~10 minutes idle and disappears from USB
  enumeration. An empty `getDevices()` usually means *asleep*, not a bug.
- WebUSB/Web Serial require a Chromium-based browser and a secure context.

## Development

```sh
npm install
npm test        # vitest — all logic testable with fakes, no hardware needed
npm run build   # tsc → dist/
```

## License

MIT
