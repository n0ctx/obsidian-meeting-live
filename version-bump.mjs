// Run by `npm version <x.y.z>` (see the "version" script): copies the new package.json version into manifest.json
// and records it in versions.json, then the three files are staged for npm's version commit.
import { readFileSync, writeFileSync } from "node:fs"

const targetVersion = process.env.npm_package_version
if (!targetVersion) throw new Error("Run this through `npm version <x.y.z>`; npm_package_version is not set.")

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"))
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)

const manifest = readJson("manifest.json")
const versions = readJson("versions.json")

manifest.version = targetVersion
versions[targetVersion] = manifest.minAppVersion

writeJson("manifest.json", manifest)
writeJson("versions.json", versions)
