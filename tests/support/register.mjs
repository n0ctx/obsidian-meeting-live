// Browser-style timer calls (window.setTimeout) resolve to Node globals in tests.
globalThis.window ??= globalThis
import { register } from "node:module"
register("data:text/javascript," + encodeURIComponent(`
export async function resolve(specifier, context, next) {
  if (specifier === "obsidian") return { url: new URL("./obsidian.ts", ${JSON.stringify(new URL("./", import.meta.url).href)}).href, shortCircuit: true }
  return next(specifier, context)
}`))
