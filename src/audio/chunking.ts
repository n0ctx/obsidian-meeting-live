// Where to cut a long recording so each piece stays under a service's upload limit.

/** Length of the window whose energy decides how quiet a spot is. */
const FRAME_MS = 100

/**
 * Cut positions in samples, from 0 to the end, for pieces of at most `size` samples. Each cut is moved back to the quietest
 * stretch within `slack` samples of where it would fall, so it is likelier to land in a pause than in the middle of a word.
 */
export function cutPoints(samples: Float32Array, size: number, slack: number, rate: number): number[] {
  const frame = Math.max(1, Math.round((rate * FRAME_MS) / 1000))
  const cuts = [0]
  let start = 0
  while (samples.length - start > size) {
    const nominal = start + size
    const from = Math.max(start + frame, nominal - slack)
    let best = nominal
    let quietest = Infinity
    for (let at = from; at + frame <= nominal; at += frame) {
      let energy = 0
      for (let i = at; i < at + frame; i++) energy += samples[i] * samples[i]
      // Ties go to the later spot, which keeps pieces long.
      if (energy <= quietest) {
        quietest = energy
        best = at + Math.floor(frame / 2)
      }
    }
    cuts.push(best)
    start = best
  }
  cuts.push(samples.length)
  return cuts
}
