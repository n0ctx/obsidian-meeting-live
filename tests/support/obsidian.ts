// Minimal stand-in for the parts of the Obsidian API used by background jobs and sessions, for Node tests only.
type Handler = (...args: unknown[]) => unknown

export class Events {
  private handlers = new Map<string, Set<Handler>>()
  on(name: string, fn: Handler) {
    if (!this.handlers.has(name)) this.handlers.set(name, new Set())
    this.handlers.get(name)!.add(fn)
    return { name, fn }
  }
  offref(ref: { name: string; fn: Handler }) {
    this.handlers.get(ref.name)?.delete(ref.fn)
  }
  trigger(name: string, ...args: unknown[]) {
    for (const fn of this.handlers.get(name) ?? []) fn(...args)
  }
}

export class FileSystemAdapter {}
export const normalizePath = (path: string) => path

export const notices: string[] = []
export class Notice {
  constructor(message: unknown) {
    notices.push(typeof message === "string" ? message : "[fragment]")
  }
  hide() {}
}

export class TFile {
  path: string
  basename: string
  constructor(path: string) {
    this.path = path
    this.basename = path.split("/").pop()!.replace(/\.md$/, "")
  }
}

// Obsidian's DOM helper globals, reduced to what notices use.
const element = (): Record<string, unknown> => ({ createDiv: element, createEl: element, createSpan: element, addEventListener() {} })
;(globalThis as Record<string, unknown>).createFragment = element
