import type { Driver, Transport, Raster1bpp, JobOptions, PrinterStatus } from './types'

export interface PrintRasterArgs {
  driver: Driver
  transport: Transport
  opts: JobOptions
}

/** Open, send the encoded job, read the trailing status, and always close. */
export async function printRaster(
  raster: Raster1bpp,
  { driver, transport, opts }: PrintRasterArgs,
): Promise<PrinterStatus> {
  const bytes = driver.encode(raster, opts)
  await transport.open()
  try {
    await transport.write(bytes)
    // 32-byte Brother status; this is the reply to the stream's EARLY status-request
    // command, so it reflects printer state around job start (missing tape, open
    // cover) — it is not a print-completion acknowledgment, and the printer may still
    // be consuming the job when this resolves. Whether closing here races the transfer
    // on real hardware is a Task 8 hardware-verification item.
    const status = await transport.read(2000, 32)
    return driver.parseStatus(status)
  } finally {
    // best-effort: a close failure must not mask the job's real outcome
    await transport.close().catch(() => {})
  }
}
