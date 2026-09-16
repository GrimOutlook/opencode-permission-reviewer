import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const ROOT = join(import.meta.dirname, "..")
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  scripts: Record<string, string>
  devDependencies: Record<string, string>
}
const contributing = readFileSync(join(ROOT, "CONTRIBUTING.md"), "utf8")

/**
 * A package lifecycle script is code execution on the installing machine,
 * before anyone can inspect what they installed. npm runs `prepare` when a
 * package is installed from a Git URL or a local path, so a `prepare` build
 * turns this repository's build pipeline into an install-time execution
 * surface. `prepack` runs only when the tarball is created, so the published
 * package ships built artifacts and consumers run no build at all.
 */
describe("package lifecycle scripts", () => {
  test("no script executes on a consumer's install", () => {
    for (const hook of ["prepare", "preinstall", "install", "postinstall"]) {
      expect(pkg.scripts[hook]).toBeUndefined()
    }
  })

  test("the build runs at pack time instead", () => {
    expect(pkg.scripts.prepack).toBe("bun run build")
  })

  test("the build stays a bundle step plus this repository's own script", () => {
    expect(pkg.scripts.build).toBe("tsup && bun scripts/copy-tui.ts")
  })

  test("the build's only third-party tool is a declared devDependency", () => {
    expect(pkg.devDependencies.tsup).toBeDefined()
  })

  test("the lifecycle choice is documented where contributors will look", () => {
    expect(contributing).toContain("prepack")
    expect(contributing).toContain("prepare")
  })
})
