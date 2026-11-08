import { SecretComponent, type App, type Setting } from "obsidian"

/** A text field bound to `target[key]`; `save` runs after every change. */
export function textField(setting: Setting, target: object, key: string, save: () => void, placeholder = ""): void {
  const values = target as Record<string, string>
  setting.addText((t) =>
    t
      .setPlaceholder(placeholder)
      .setValue(String(values[key]))
      .onChange((v) => {
        values[key] = v.trim()
        save()
      }),
  )
}

/** A secret picker bound to `target[key]`, which holds the SecretStorage id. */
export function secretField(app: App, setting: Setting, target: object, key: string, save: () => void): void {
  const values = target as Record<string, string>
  setting.addComponent((el) =>
    new SecretComponent(app, el).setValue(values[key]).onChange((id) => {
      values[key] = id ?? ""
      save()
    }),
  )
}
