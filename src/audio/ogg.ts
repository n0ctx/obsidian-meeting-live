// Minimal Ogg (RFC 3533) muxer for Opus (RFC 7845). Pages never split packets, so every
// flushed page is independently valid and a truncated file still plays up to its last page.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let r = i << 24
    for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1
    table[i] = r >>> 0
  }
  return table
})()

function crc32(data: Uint8Array): number {
  let crc = 0
  for (let i = 0; i < data.length; i++) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ data[i]) & 0xff]) >>> 0
  return crc >>> 0
}

const FLAG_BOS = 0x02
const FLAG_EOS = 0x04
export const OPUS_DEFAULT_PRESKIP = 312

function buildPage(packets: Uint8Array[], granule: bigint, serial: number, sequence: number, flags: number): Uint8Array {
  const lacing: number[] = []
  for (const p of packets) {
    let len = p.length
    while (len >= 255) {
      lacing.push(255)
      len -= 255
    }
    lacing.push(len)
  }
  const bodyLength = packets.reduce((n, p) => n + p.length, 0)
  const page = new Uint8Array(27 + lacing.length + bodyLength)
  const view = new DataView(page.buffer)
  page.set([0x4f, 0x67, 0x67, 0x53], 0)
  page[4] = 0
  page[5] = flags
  view.setBigInt64(6, granule, true)
  view.setUint32(14, serial, true)
  view.setUint32(18, sequence, true)
  page[26] = lacing.length
  page.set(lacing, 27)
  let offset = 27 + lacing.length
  for (const p of packets) {
    page.set(p, offset)
    offset += p.length
  }
  view.setUint32(22, crc32(page), true)
  return page
}

function lacingCount(packet: Uint8Array): number {
  return Math.floor(packet.length / 255) + 1
}

export function opusHead(channels: number, inputRate: number, preSkip: number): Uint8Array {
  const head = new Uint8Array(19)
  const view = new DataView(head.buffer)
  head.set(new TextEncoder().encode("OpusHead"), 0)
  head[8] = 1
  head[9] = channels
  view.setUint16(10, preSkip, true)
  view.setUint32(12, inputRate, true)
  view.setInt16(16, 0, true)
  head[18] = 0
  return head
}

function opusTags(vendor: string): Uint8Array {
  const vendorBytes = new TextEncoder().encode(vendor)
  const tags = new Uint8Array(8 + 4 + vendorBytes.length + 4)
  const view = new DataView(tags.buffer)
  tags.set(new TextEncoder().encode("OpusTags"), 0)
  view.setUint32(8, vendorBytes.length, true)
  tags.set(vendorBytes, 12)
  view.setUint32(12 + vendorBytes.length, 0, true)
  return tags
}

export class OggOpusMuxer {
  private sequence = 0
  private granule = 0n
  private pending: Uint8Array[] = []
  private pendingLacing = 0

  private readonly serial: number
  private readonly head: Uint8Array

  constructor(serial: number, head: Uint8Array) {
    this.serial = serial
    this.head = head
  }

  headers(): Uint8Array {
    const first = buildPage([this.head], 0n, this.serial, this.sequence++, FLAG_BOS)
    const second = buildPage([opusTags("Meeting Live")], 0n, this.serial, this.sequence++, 0)
    const out = new Uint8Array(first.length + second.length)
    out.set(first, 0)
    out.set(second, first.length)
    return out
  }

  /** Adds an Opus packet; returns a completed page when the current one is full. */
  addPacket(packet: Uint8Array, samples48k: number): Uint8Array | undefined {
    let page: Uint8Array | undefined
    if (this.pendingLacing + lacingCount(packet) > 255) page = this.flush(false)
    this.pending.push(packet)
    this.pendingLacing += lacingCount(packet)
    this.granule += BigInt(Math.round(samples48k))
    return page
  }

  flush(eos: boolean): Uint8Array | undefined {
    if (this.pending.length === 0 && !eos) return undefined
    const page = buildPage(this.pending, this.granule, this.serial, this.sequence++, eos ? FLAG_EOS : 0)
    this.pending = []
    this.pendingLacing = 0
    return page
  }
}

export interface OggScan {
  /** Byte length of the valid prefix made of complete, checksummed pages. */
  validLength: number
  lastGranule: number
  preSkip: number
  hasEos: boolean
}

export function scanOgg(data: Uint8Array): OggScan {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  let offset = 0
  let lastGranule = 0
  let preSkip = OPUS_DEFAULT_PRESKIP
  let hasEos = false
  while (offset + 27 <= data.length) {
    if (data[offset] !== 0x4f || data[offset + 1] !== 0x67 || data[offset + 2] !== 0x67 || data[offset + 3] !== 0x53) break
    const segments = data[offset + 26]
    if (offset + 27 + segments > data.length) break
    let bodyLength = 0
    for (let i = 0; i < segments; i++) bodyLength += data[offset + 27 + i]
    const end = offset + 27 + segments + bodyLength
    if (end > data.length) break
    const page = data.slice(offset, end)
    const expected = view.getUint32(offset + 22, true)
    page[22] = page[23] = page[24] = page[25] = 0
    if (crc32(page) !== expected) break
    const body = offset + 27 + segments
    if (offset === 0 && bodyLength >= 19) preSkip = view.getUint16(body + 10, true)
    const granule = Number(view.getBigInt64(offset + 6, true))
    if (granule > 0) lastGranule = granule
    hasEos = (data[offset + 5] & FLAG_EOS) !== 0
    offset = end
  }
  return { validLength: offset, lastGranule, preSkip, hasEos }
}

export function oggDurationMs(scan: OggScan): number {
  return Math.max(0, ((scan.lastGranule - scan.preSkip) / 48000) * 1000)
}
