import assert from "node:assert/strict"
import { test } from "node:test"
import { OggOpusMuxer, oggDurationMs, opusHead, scanOgg } from "../src/audio/ogg.ts"
import { AsrResampler, PcmRing } from "../src/audio/pcm.ts"
import { repairWav, wavHeader } from "../src/audio/wav.ts"

function concat(parts: (Uint8Array | undefined)[]): Uint8Array {
  const list = parts.filter((p): p is Uint8Array => !!p)
  const out = new Uint8Array(list.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of list) {
    out.set(p, o)
    o += p.length
  }
  return out
}

function muxSeconds(seconds: number, eos: boolean): Uint8Array {
  const mux = new OggOpusMuxer(1234, opusHead(1, 48000, 312))
  const parts: (Uint8Array | undefined)[] = [mux.headers()]
  for (let i = 0; i < seconds * 50; i++) parts.push(mux.addPacket(new Uint8Array(300).fill(i % 256), 960))
  parts.push(mux.flush(eos))
  return concat(parts)
}

test("ogg muxer produces checksummed pages with the right duration", () => {
  const file = muxSeconds(10, true)
  const scan = scanOgg(file)
  assert.equal(scan.validLength, file.length)
  assert.equal(scan.hasEos, true)
  assert.equal(scan.preSkip, 312)
  assert.equal(Math.round(oggDurationMs(scan)), Math.round(10000 - (312 / 48000) * 1000))
})

test("truncated ogg recovers to the last complete page", () => {
  const file = muxSeconds(6, false)
  const cut = file.subarray(0, file.length - 777)
  const scan = scanOgg(cut)
  assert.ok(scan.validLength < cut.length)
  assert.ok(scan.validLength > 0)
  assert.equal(scanOgg(cut.subarray(0, scan.validLength)).validLength, scan.validLength)
  assert.ok(oggDurationMs(scan) > 3000 && oggDurationMs(scan) < 6000)
})

test("corrupted page stops the scan", () => {
  const file = muxSeconds(2, true)
  const broken = file.slice()
  broken[broken.length - 10] ^= 0xff
  assert.ok(scanOgg(broken).validLength < file.length)
})

test("wav header repair rounds to whole frames", () => {
  const header = wavHeader(48000, 2, 0)
  assert.equal(header.length, 44)
  const repaired = repairWav(44 + 48000 * 4 + 3, 48000, 2)
  assert.equal(repaired.dataBytes, 48000 * 4)
  assert.equal(Math.round(repaired.durationMs), 1000)
  assert.equal(new DataView(repaired.header.buffer).getUint32(40, true), 48000 * 4)
})

test("resampler keeps rate exact across chunk boundaries", () => {
  for (const rate of [48000, 44100]) {
    const r = new AsrResampler(rate)
    let out = 0
    for (let i = 0; i < 100; i++) out += r.process([new Float32Array(rate / 100).fill(0.5)]).length
    assert.ok(Math.abs(out - 16000) <= 2, `${rate}: ${out}`)
  }
})

test("ring buffer drops oldest samples and respects seek floor", () => {
  const ring = new PcmRing(10)
  ring.seek(100)
  assert.equal(ring.start, 100)
  ring.push(Int16Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]))
  assert.equal(ring.end, 112)
  assert.equal(ring.start, 102)
  assert.deepEqual(Array.from(ring.read(100, 4)), [3, 4, 5, 6])
})
