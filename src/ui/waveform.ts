import type { MeetingSession } from "../meeting/session.ts"

const BAR = 3
const GAP = 2

/** Scrolling level meter fed by the real microphone RMS history. Animates only while recording. */
export class Waveform {
  private readonly canvas: HTMLCanvasElement
  private readonly session: MeetingSession
  private frame = 0
  private drawnCursor = -1
  private drawnState = ""

  constructor(parent: HTMLElement, session: MeetingSession) {
    this.session = session
    this.canvas = parent.createEl("canvas", { cls: "ml-wave", attr: { "aria-hidden": "true" } })
  }

  start(): void {
    const loop = () => {
      this.draw()
      this.frame = window.requestAnimationFrame(loop)
    }
    if (!this.frame) this.frame = window.requestAnimationFrame(loop)
  }

  stop(): void {
    if (this.frame) window.cancelAnimationFrame(this.frame)
    this.frame = 0
  }

  draw(force = false): void {
    const { canvas, session } = this
    if (!canvas.isConnected) return
    const width = canvas.clientWidth
    const height = canvas.clientHeight
    if (!width || !height) return
    const state = `${session.status}:${width}:${height}:${document.body.classList.contains("theme-dark")}`
    if (!force && session.levelCursor === this.drawnCursor && state === this.drawnState) return
    this.drawnCursor = session.levelCursor
    this.drawnState = state
    const ratio = window.devicePixelRatio || 1
    if (canvas.width !== Math.round(width * ratio)) {
      canvas.width = Math.round(width * ratio)
      canvas.height = Math.round(height * ratio)
    }
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    ctx.clearRect(0, 0, width, height)
    const style = getComputedStyle(canvas)
    const live = session.status === "recording"
    ctx.fillStyle = style.getPropertyValue(live ? "--ml-wave-live" : "--ml-wave-idle").trim() || "#888"
    const bars = Math.floor((width + GAP) / (BAR + GAP))
    const history = session.levels
    const mid = height / 2
    for (let i = 0; i < bars; i++) {
      const index = session.levelCursor - bars + i
      const level = index >= 0 && session.levelCursor > 0 ? history[((index % history.length) + history.length) % history.length] : 0
      const age = (bars - i) / bars
      const h = Math.max(2, level * (height - 2))
      ctx.globalAlpha = live ? 0.35 + 0.65 * (1 - age * 0.7) : 0.45
      const x = i * (BAR + GAP)
      ctx.beginPath()
      ctx.roundRect(x, mid - h / 2, BAR, h, 1.5)
      ctx.fill()
    }
    ctx.globalAlpha = 1
  }
}
