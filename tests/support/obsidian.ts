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

// The language of Obsidian's interface and the platform it runs on, which tests set. Chinese on macOS is what the plugin was written for.
let language = "zh-CN"
export const getLanguage = () => language
export const setLanguage = (code: string) => void (language = code)
export const Platform = { isMacOS: true, isWin: false, isLinux: false }
export const setPlatform = (os: "mac" | "win" | "linux") => Object.assign(Platform, { isMacOS: os === "mac", isWin: os === "win", isLinux: os === "linux" })

// A DOM element reduced to what the settings page does to one: nesting, and the Setting rows drawn into it.
export class FakeEl {
  children: FakeEl[] = []
  rows: Setting[] = []
  /** Children and rows in the order they were drawn. */
  order: (FakeEl | Setting)[] = []
  text = ""
  style: Record<string, string> = {}
  value = ""
  rows_ = 0
  type = ""
  createDiv(options?: { text?: string }) {
    return this.child(options)
  }
  createSpan(options?: { text?: string }) {
    return this.child(options)
  }
  createEl(_tag: string, options?: { text?: string }) {
    return this.child(options)
  }
  private child(options?: { text?: string }) {
    const el = new FakeEl()
    el.text = options?.text ?? ""
    this.children.push(el)
    this.order.push(el)
    return el
  }
  empty() {
    this.children = []
    this.rows = []
    this.order = []
  }
  setText(text: string) {
    this.text = text
  }
  addClass() {}
  toggleClass() {}
  addEventListener() {}
  appendChild() {}
}

/** Every Setting row drawn under an element, headings apart; what the page shows. */
export const settingRows = (el: FakeEl): Setting[] => el.order.flatMap((node) => (node instanceof Setting ? (node.heading ? [] : [node]) : settingRows(node)))

/** A control inside a Setting: any call chains and does nothing, so a page can be drawn without anyone touching it. */
const control = (): Record<string, unknown> =>
  new Proxy({}, { get: (_target, prop) => (prop === "inputEl" || prop === "buttonEl" || prop === "selectEl" ? new FakeEl() : () => control()) })

/** A row of the settings page. Controls are inert, so nothing fires while a test counts rows. */
export class Setting {
  heading = false
  name = ""
  desc = ""
  settingEl = new FakeEl()
  descEl = new FakeEl()
  controls: string[] = []
  constructor(container: FakeEl) {
    container.rows.push(this)
    container.order.push(this)
  }
  setName(name: string) {
    this.name = name
    return this
  }
  setDesc(desc: string) {
    this.desc = desc
    return this
  }
  setHeading() {
    this.heading = true
    return this
  }
}
for (const method of ["addText", "addTextArea", "addDropdown", "addToggle", "addSlider", "addButton", "addExtraButton", "addComponent"]) {
  ;(Setting.prototype as unknown as Record<string, unknown>)[method] = function (this: Setting, build: (control: unknown) => unknown) {
    this.controls.push(method)
    build(control())
    return this
  }
}

export class PluginSettingTab {
  containerEl = new FakeEl()
  app: unknown
  constructor(app: unknown, _plugin: unknown) {
    this.app = app
  }
}
export class SecretComponent {
  setValue() {
    return this
  }
  onChange() {
    return this
  }
}
export class FileSystemAdapter {}
export class MarkdownView {}
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
  name: string
  basename: string
  parent: TFolder | null = null
  constructor(path: string) {
    this.path = path
    this.name = path.split("/").pop()!
    this.basename = this.name.replace(/\.md$/, "")
  }
}

export class TFolder {
  path: string
  parent: TFolder | null = null
  children: (TFile | TFolder)[]
  constructor(path: string, children: (TFile | TFolder)[] = []) {
    this.path = path
    this.children = children
    for (const child of children) child.parent = this
  }
}

export class Vault {
  static recurseChildren(root: TFolder, callback: (file: TFile | TFolder) => unknown) {
    callback(root)
    for (const child of root.children) child instanceof TFolder ? Vault.recurseChildren(child, callback) : callback(child)
  }
}

// Obsidian's DOM helper globals, reduced to what notices use.
const element = (): Record<string, unknown> => ({ createDiv: element, createEl: element, createSpan: element, addEventListener() {} })
;(globalThis as Record<string, unknown>).createFragment = element
