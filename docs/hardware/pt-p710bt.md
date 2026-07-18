# PT-P710BT hardware & OS-layer reference

Empirical findings from direct inspection on macOS 26 (Darwin 25.5.0, Apple Silicon),
Chrome 150/151, July 2026. This is the canonical reference for how the Brother
PT-P710BT presents over USB and Bluetooth and what each browser/OS layer can and
cannot do with it. Plan-level history lives in
`docs/superpowers/plans/2026-06-27-web-label-printing.md` (Hardware Verification
Results) and `2026-07-18-webusb-handoff.md`.

## Device identity

| Fact | Value |
|---|---|
| USB vendor / product id | `0x04F9` (Brother) / `0x20AF` |
| USB product string | `PT-P710BT` |
| USB serial number | `000B2Z193867` |
| Bluetooth name | `PT-P710BT3867` (suffix = last 4 of serial) |
| Bluetooth address | `EC:79:49:64:1F:B8` (Classic; Minor Type "Printer") |
| macOS virtual serial device | `/dev/cu.PT-P710BT3867` |

## USB layer

Full-speed (12 Mbps) composite device, `bDeviceClass 0` at the device level,
one configuration.

```
Configuration 1
└── Interface 0, alternate 0
    ├── bInterfaceClass    0x07  (Printer)
    ├── bInterfaceSubClass 0x01
    ├── bInterfaceProtocol 0x02  (bidirectional)
    ├── Endpoint 0x02  bulk OUT, 64-byte max packet   ← job bytes
    └── Endpoint 0x81  bulk IN,  64-byte max packet   ← 32-byte status replies
```

- **No kernel driver claims interface 0.** ioreg shows only
  `AppleUSBHostCompositeDevice` at the device level and passive
  `AppleUSBHostDeviceUserClient`s from user-space processes (Chrome's WebUSB
  detector, Zoom's device watcher). This is the precondition that makes WebUSB
  `claimInterface()` possible on macOS, and it holds.
- Verified end-to-end from Chrome WebUSB (2026-07-18): `open()` →
  `selectConfiguration(1)` → `claimInterface(0)` → bulk OUT invalidate+init+
  status-request (100×`00`, `1B 40`, `1B 69 53`) → bulk IN returned a valid
  32-byte status. **No mode toggle (P700-style "Editor Lite") is needed;
  the raster interface is live immediately.**

Observed status reply with 12 mm laminated TZe tape loaded:

```
80 20 42 30 76 30 00 00 00 00 0c 01 00 00 00 00
00 00 00 00 00 00 00 00 01 08 00 00 00 00 00 00
 │  │  │     │        │  │  └─ media type 0x01 (laminated tape)
 │  │  │     │        │  └─ media width, mm (0x0C = 12)
 │  │  │     │        └─ error info 1 & 2 (bytes 8–9, both clear)
 │  │  │     └─ model code 0x76 (PT-P710BT)
 │  │  └─ 'B' series marker
 │  └─ status size (0x20 = 32 bytes)
 └─ print-head mark 0x80
```

## Power behavior (important)

The printer **auto-powers off after idle** (roughly 10 minutes observed) even
while USB-connected. When it sleeps:

- It drops off the USB bus as far as live enumeration is concerned — Chrome's
  USB chooser reports "no compatible devices found" and `chrome://usb-internals`
  loses the row.
- A stale `ioreg` node can linger, which makes shell-level inspection
  misleading — trust live enumeration (or a fresh replug/power-on), not a
  cached registry tree. (Observed once; timing consistent with sleep, not
  re-verified in isolation.)

Consequences for the app: the WebUSB picker and any `getDevices()` lookup will
simply not see a sleeping printer. The transport/UI must treat "device absent"
as "printer may be asleep — press its power button", not as a fatal error.

## Bluetooth layer

- **What works:** direct RFCOMM to channel 1 via IOBluetooth (see
  `scripts/hardware-debug/rfcomm_probe.swift`, `print_job.swift`). A real label
  printed this way 2026-07-18; same raster protocol and status replies as USB.
- **What's broken (macOS 26 platform bug):** the virtual Bluetooth serial port
  `/dev/cu.PT-P710BT3867`. `open()` succeeds instantly but writes are silently
  swallowed and the RFCOMM link is never established.
- **Chrome Web Serial** sits on that virtual port, so it inherits the breakage:
  the serial picker *does list* "PT-P710BT3867 – Paired", but `port.open()`
  fails with "Failed to open serial port" (confirmed in-app 2026-07-18).
  `webSerialTransport.ts` is spec-correct; it can only work on platforms whose
  SPP serial ports function.
- The OS pairing itself is healthy and finicky to re-establish — leave it alone.

## Browser-layer summary

| Path | Status on this machine |
|---|---|
| WebUSB (`navigator.usb`) | **Works end-to-end** — chooser lists printer when awake, interface claimable, bulk I/O verified |
| Web Serial over BT SPP | Dead — macOS 26 virtual serial port bug (not an app bug) |
| Web Bluetooth | Not applicable — printer is BT Classic (SPP), not BLE GATT |

WebUSB permission persists per Chrome profile + origin + device; after one
picker grant, `getDevices()` returns the printer with no further gesture.

## Automation gotchas (for tests/tooling)

- Puppeteer's `page.waitForDevicePrompt()` (CDP `DeviceAccess`) never fires
  events against Chrome 150 on this machine — `DeviceAccess.enable` succeeds
  but `deviceRequestPrompted` is never emitted, so the WebUSB picker cannot be
  driven headlessly. A human click on the real picker is currently required
  for first-time permission; after that, automation can use `getDevices()`.
- With zero visible devices Chrome auto-cancels `requestDevice` almost
  immediately (`NotFoundError: No device selected`) rather than leaving the
  empty chooser open, at least under automation.
- `chrome://usb-internals` (shadow-DOM UI) is scrapeable and its Test Device
  Manager can inject fake USB devices — useful to prove chooser plumbing
  without hardware.
- Chrome for Testing ignores user-level `defaults` policies
  (`WebUsbAllowDevicesForUrls` shows "Not set"), so the no-chooser policy
  route is not available for throwaway test browsers.
