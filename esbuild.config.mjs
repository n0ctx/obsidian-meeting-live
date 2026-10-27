import esbuild from "esbuild"
import builtins from "node:module"

const production = process.argv[2] === "production"

await esbuild.build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*", ...builtins.builtinModules, ...builtins.builtinModules.map((m) => `node:${m}`), "bufferutil", "utf-8-validate"],
  format: "cjs",
  target: "es2022",
  platform: "node",
  logLevel: "info",
  sourcemap: production ? false : "inline",
  minify: production,
  treeShaking: true,
  outfile: "main.js",
})
