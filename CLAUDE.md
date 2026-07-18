# obwat

"O Brother Where Art Thou" — Brother P-touch raster printing from the browser
over WebUSB (preferred) or Web Serial. Extracted from `~/src/lbx-editor`.

## Architecture: two layers

1. **Primitives** (à la carte, all exported): `types` (RgbaImage → Raster1bpp
   boundary), `rasterCore` (threshold + bit packing), `packbits`,
   `brotherDriver` (PT raster command stream), `webUsbTransport` /
   `webSerialTransport` (structural device interfaces, testable with fakes),
   `profiles` (media geometry), `printJob` (`printRaster`), `keepalive`.
2. **Facade**: `createBrotherPrinter()` — a *connectionless* session. Every
   operation acquires → claims → works → releases behind an internal mutex; no
   consumer-visible open/close (the printer auto-sleeps and vanishes from USB
   enumeration, so "connected" is not a stable state). Owns device acquisition
   and keepalive; emits `onStatus`.

## Rules

- **No UX policy in this package.** No localStorage, no alerts, no copy.
  Consumers get typed errors (`NoGrantedDeviceError`) and decide what to show.
- The app renders pixels; obwat owns everything from pixels (`RgbaImage`) to
  paper. Label/scene rendering does NOT belong here.
- PT-P710BT is the only profile until real second-printer hardware exists.

## Hardware

`docs/hardware/pt-p710bt.md` is the canonical hardware/OS reference (moved
from lbx-editor). `scripts/hardware-debug/` holds one-off probe tools.
The printer auto-powers off after ~10 min idle and disappears from USB
enumeration — an empty `getDevices()` usually means *asleep*, not a bug.

## Consumers

`~/src/lbx-editor` links via `file:../obwat` + vite alias + tsconfig paths to
`src/index.ts` (same pattern as its weasel/bil-lbx links).

## Development

```sh
npm install
npm test        # vitest, all logic testable with fakes — no hardware needed
npm run build   # tsc → dist/
```
