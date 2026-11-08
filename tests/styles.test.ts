import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8")
const rule = (selector: string) => new RegExp(`(?:^|\\n)${selector.replace(/[.[\]]/g, "\\$&")} \\{([^}]*)\\}`).exec(css)?.[1] ?? assert.fail(`no rule for ${selector}`)

// Layout cannot be run here; this pins the one property whose reintroduction cut short titles like "Test me…" (measured in a browser against the real stylesheet).
test("the chip row reserves no width, so a short card title keeps its full width", () => {
  const meta = rule(".ml-meta")
  assert.match(meta, /min-width:\s*0\s*;/)
  assert.doesNotMatch(meta, /min-content|fit-content/)
  assert.match(rule(".ml-status"), /flex:\s*none/, "the status pill never shrinks")
})
