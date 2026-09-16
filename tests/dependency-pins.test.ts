import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const ROOT = join(import.meta.dirname, "..")
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  dependencies: Record<string, string>
}
const lock = readFileSync(join(ROOT, "bun.lock"), "utf8")
const policy = readFileSync(join(ROOT, "DEPENDENCIES.md"), "utf8")

const EXACT = /^[0-9]+\.[0-9]+\.[0-9]+$/

/**
 * The OpenTUI packages ship native, platform-specific artifacts and the TUI
 * overlay is compiled by OpenCode's host pipeline, so a patch difference can
 * change runtime behavior. Exact pins keep every move through an explicit,
 * reviewable commit — and DEPENDENCIES.md keeps a record of what was checked.
 */
describe("runtime dependency pins", () => {
  test("every runtime dependency is pinned to an exact version", () => {
    for (const [name, range] of Object.entries(pkg.dependencies)) {
      expect(`${name}@${range}`).toMatch(new RegExp(`^${name}@${EXACT.source.slice(1, -1)}$`))
    }
  })

  test("the OpenTUI packages are pinned together at the same version", () => {
    expect(pkg.dependencies["@opentui/solid"]).toBe(pkg.dependencies["@opentui/core"]!)
  })

  test("the lockfile resolves the OpenTUI platform packages to the pinned version", () => {
    const version = pkg.dependencies["@opentui/core"]!
    const platforms = [
      ...lock.matchAll(/"@opentui\/core-[a-z0-9-]+": \["@opentui\/core-[a-z0-9-]+@([^"]+)"/g),
    ]
    expect(platforms.length).toBeGreaterThan(0)
    for (const [, resolved] of platforms) expect(resolved).toBe(version)
  })

  test("the dependency policy records a review for the pinned OpenTUI version", () => {
    expect(policy).toContain(pkg.dependencies["@opentui/core"]!)
  })
})
