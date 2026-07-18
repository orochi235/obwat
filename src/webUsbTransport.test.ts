import { describe, it, expect } from 'vitest'
import { createWebUsbTransport, type UsbDeviceLike, type UsbConfigurationLike } from './webUsbTransport'

/** Endpoint layout matching the real PT-P710BT (bulk OUT 0x02, bulk IN 0x81). */
const PRINTER_CONFIG: UsbConfigurationLike = {
  configurationValue: 1,
  interfaces: [
    {
      interfaceNumber: 0,
      alternates: [
        {
          endpoints: [
            { endpointNumber: 2, direction: 'out', type: 'bulk' },
            { endpointNumber: 1, direction: 'in', type: 'bulk' },
          ],
        },
      ],
    },
  ],
}

function dataView(bytes: number[]): DataView {
  return new DataView(Uint8Array.from(bytes).buffer)
}

function fakeDevice(opts: { config?: UsbConfigurationLike | null; preConfigured?: boolean } = {}) {
  const config = opts.config === undefined ? PRINTER_CONFIG : opts.config
  const calls: string[] = []
  const written: Array<{ endpoint: number; bytes: Uint8Array }> = []
  const reads: Array<{ status: string; data?: DataView }> = []
  let configured = opts.preConfigured ?? false

  const device: UsbDeviceLike = {
    get configuration() {
      return configured ? config : null
    },
    async open() { calls.push('open') },
    async close() { calls.push('close') },
    async selectConfiguration(value: number) {
      calls.push(`selectConfiguration(${value})`)
      configured = true
    },
    async claimInterface(num: number) { calls.push(`claimInterface(${num})`) },
    async releaseInterface(num: number) { calls.push(`releaseInterface(${num})`) },
    async transferOut(endpoint: number, data: Uint8Array) {
      written.push({ endpoint, bytes: data })
      return { status: 'ok' as const, bytesWritten: data.length }
    },
    async transferIn() {
      const next = reads.shift()
      if (!next) return new Promise(() => {}) // hang, simulating no data — read() must time out
      return next
    },
  }
  return { device, calls, written, reads }
}

describe('WebUsbTransport', () => {
  it('open() selects configuration 1 when unset, claims the interface; close() releases and closes', async () => {
    const { device, calls } = fakeDevice()
    const t = createWebUsbTransport(device)
    await t.open()
    expect(calls).toEqual(['open', 'selectConfiguration(1)', 'claimInterface(0)'])
    await t.close()
    expect(calls).toEqual(['open', 'selectConfiguration(1)', 'claimInterface(0)', 'releaseInterface(0)', 'close'])
  })

  it('open() skips selectConfiguration when a configuration is already active', async () => {
    const { device, calls } = fakeDevice({ preConfigured: true })
    const t = createWebUsbTransport(device)
    await t.open()
    expect(calls).toEqual(['open', 'claimInterface(0)'])
  })

  it('open() discovers the bulk pair on a later interface and write() uses its OUT endpoint', async () => {
    const config: UsbConfigurationLike = {
      configurationValue: 1,
      interfaces: [
        {
          interfaceNumber: 0,
          alternates: [
            { endpoints: [{ endpointNumber: 3, direction: 'in', type: 'interrupt' }] },
          ],
        },
        {
          interfaceNumber: 1,
          alternates: [
            {
              endpoints: [
                { endpointNumber: 5, direction: 'in', type: 'bulk' },
                { endpointNumber: 4, direction: 'out', type: 'bulk' },
              ],
            },
          ],
        },
      ],
    }
    const { device, calls, written } = fakeDevice({ config, preConfigured: true })
    const t = createWebUsbTransport(device)
    await t.open()
    expect(calls).toContain('claimInterface(1)')
    await t.write(Uint8Array.from([1, 2, 3]))
    expect(written[0].endpoint).toBe(4)
  })

  it('open() throws when no interface has both bulk endpoints', async () => {
    const config: UsbConfigurationLike = {
      configurationValue: 1,
      interfaces: [
        {
          interfaceNumber: 0,
          alternates: [
            { endpoints: [{ endpointNumber: 1, direction: 'in', type: 'bulk' }] },
          ],
        },
      ],
    }
    const { device } = fakeDevice({ config, preConfigured: true })
    const t = createWebUsbTransport(device)
    await expect(t.open()).rejects.toThrow('no USB interface with bulk IN and OUT endpoints')
  })

  it('write() sends the bytes to the bulk OUT endpoint', async () => {
    const { device, written } = fakeDevice()
    const t = createWebUsbTransport(device)
    await t.open()
    await t.write(Uint8Array.from([9, 8, 7]))
    expect(written).toHaveLength(1)
    expect(written[0].endpoint).toBe(2)
    expect(Array.from(written[0].bytes)).toEqual([9, 8, 7])
  })

  it('write() throws on a non-ok transfer status', async () => {
    const { device } = fakeDevice()
    device.transferOut = async () => ({ status: 'stall', bytesWritten: 0 })
    const t = createWebUsbTransport(device)
    await t.open()
    await expect(t.write(Uint8Array.from([1]))).rejects.toThrow('USB write failed: stall')
  })

  it('write() throws on a short write', async () => {
    const { device } = fakeDevice()
    device.transferOut = async (_ep: number, data: Uint8Array) => ({ status: 'ok', bytesWritten: data.length - 1 })
    const t = createWebUsbTransport(device)
    await t.open()
    await expect(t.write(Uint8Array.from([1, 2]))).rejects.toThrow('USB short write: 1/2')
  })

  it('read() accumulates chunks until minBytes', async () => {
    const { device, reads } = fakeDevice()
    reads.push({ status: 'ok', data: dataView([1, 2]) }, { status: 'ok', data: dataView([3, 4, 5]) })
    const t = createWebUsbTransport(device)
    await t.open()
    const got = await t.read(1000, 5)
    expect(Array.from(got)).toEqual([1, 2, 3, 4, 5])
  })

  it('read() times out and returns what accumulated', async () => {
    const { device, reads } = fakeDevice()
    reads.push({ status: 'ok', data: dataView([1]) })
    // second transferIn hangs — the deadline must fire
    const t = createWebUsbTransport(device)
    await t.open()
    const got = await t.read(50, 32)
    expect(Array.from(got)).toEqual([1])
  })

  it('write() and read() throw before open()', async () => {
    const { device } = fakeDevice()
    const t = createWebUsbTransport(device)
    await expect(t.write(Uint8Array.from([1]))).rejects.toThrow('USB transport not open')
    await expect(t.read(10)).rejects.toThrow('USB transport not open')
  })

  it('read() stops early on a non-ok transfer status and returns the partial data', async () => {
    const { device, reads } = fakeDevice()
    reads.push({ status: 'stall', data: dataView([1, 2]) })
    const t = createWebUsbTransport(device)
    await t.open()
    const got = await t.read(1000, 32)
    expect(Array.from(got)).toEqual([1, 2])
  })

  it('open() failure at claimInterface leaves the transport unopened', async () => {
    const { device } = fakeDevice()
    device.claimInterface = async () => {
      throw new Error('claim denied')
    }
    const t = createWebUsbTransport(device)
    await expect(t.open()).rejects.toThrow('claim denied')
    await expect(t.write(Uint8Array.from([1]))).rejects.toThrow('USB transport not open')
    await t.close() // must not throw; nothing was claimed
  })

  it('close() swallows releaseInterface and close failures', async () => {
    const { device } = fakeDevice()
    device.releaseInterface = async () => {
      throw new Error('release failed')
    }
    device.close = async () => {
      throw new Error('close failed')
    }
    const t = createWebUsbTransport(device)
    await t.open()
    await expect(t.close()).resolves.toBeUndefined()
  })
})
