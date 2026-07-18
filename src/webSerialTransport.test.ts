import { describe, it, expect } from 'vitest'
import { createWebSerialTransport, type SerialPortLike } from './webSerialTransport'

function fakePort() {
  const written: Uint8Array[] = []
  let opened = false
  const port: SerialPortLike = {
    async open() { opened = true },
    async close() { opened = false },
    get writable() {
      return {
        getWriter: () => ({
          async write(chunk: Uint8Array) { written.push(chunk) },
          releaseLock() {},
        }),
      }
    },
    get readable() {
      return {
        getReader: () => ({
          async read() { return { value: Uint8Array.from([0x80]), done: false } },
          releaseLock() {},
          async cancel() {},
        }),
      }
    },
  }
  return { port, written, isOpen: () => opened }
}

describe('WebSerialTransport', () => {
  it('opens, writes, and closes through the injected port', async () => {
    const { port, written, isOpen } = fakePort()
    const t = createWebSerialTransport(port, { baudRate: 9600 })
    await t.open()
    expect(isOpen()).toBe(true)
    await t.write(Uint8Array.from([1, 2, 3]))
    expect(Array.from(written[0])).toEqual([1, 2, 3])
    await t.close()
    expect(isOpen()).toBe(false)
  })

  it('reads available bytes', async () => {
    const { port } = fakePort()
    const t = createWebSerialTransport(port, { baudRate: 9600 })
    await t.open()
    const got = await t.read(100)
    expect(Array.from(got)).toEqual([0x80])
  })

  it('accumulates chunked reads', async () => {
    const chunks = [Uint8Array.from([1, 2]), Uint8Array.from([3, 4, 5])]
    let chunkIndex = 0
    const port: SerialPortLike = {
      async open() {},
      async close() {},
      get writable() { return null },
      get readable() {
        return {
          getReader: () => ({
            async read() {
              const chunk = chunks[chunkIndex++]
              return { value: chunk, done: false }
            },
            releaseLock() {},
            async cancel() {},
          }),
        }
      },
    }
    const t = createWebSerialTransport(port, { baudRate: 9600 })
    await t.open()
    const got = await t.read(1000, 5)
    expect(Array.from(got)).toEqual([1, 2, 3, 4, 5])
  })

  it('times out and returns accumulated bytes', async () => {
    const port: SerialPortLike = {
      async open() {},
      async close() {},
      get writable() { return null },
      get readable() {
        return {
          getReader: () => ({
            async read() {
              // Never resolves, simulating a hang
              await new Promise(() => {})
              return { value: undefined, done: false }
            },
            releaseLock() {},
            async cancel() {},
          }),
        }
      },
    }
    const t = createWebSerialTransport(port, { baudRate: 9600 })
    await t.open()
    const got = await t.read(50)
    expect(Array.from(got)).toEqual([])
  })

  it('write failure still releases lock', async () => {
    let releaseLockCalled = false
    const port: SerialPortLike = {
      async open() {},
      async close() {},
      get writable() {
        return {
          getWriter: () => ({
            async write() { throw new Error('write failed') },
            releaseLock() { releaseLockCalled = true },
          }),
        }
      },
      get readable() { return null },
    }
    const t = createWebSerialTransport(port, { baudRate: 9600 })
    await t.open()
    await expect(t.write(Uint8Array.from([1, 2, 3]))).rejects.toThrow('write failed')
    expect(releaseLockCalled).toBe(true)
  })

  it('read throws when readable is null', async () => {
    const port: SerialPortLike = {
      async open() {},
      async close() {},
      get writable() { return null },
      get readable() { return null },
    }
    const t = createWebSerialTransport(port, { baudRate: 9600 })
    await t.open()
    await expect(t.read(100)).rejects.toThrow('serial port not readable')
  })
})
