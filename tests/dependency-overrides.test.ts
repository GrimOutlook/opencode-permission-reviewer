import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const ROOT = join(import.meta.dir, "..")

/*
 * Security overrides for transitive advisories.
 *
 * `bun audit` reported two low-severity advisories that we cannot reach through
 * a direct dependency, because both packages are pinned by something upstream:
 *
 *   - @babel/core  GHSA-4x5r-pxfx-6jf8 ("Arbitrary File Read via sourceMappingURL
 *     Comment", affects <= 7.29.0). Pulled in at exactly 7.28.0 by
 *     @opentui/solid, which is part of the *runtime* closure.
 *   - esbuild  GHSA-g7r4-m6w7-qqqr ("arbitrary file read when running the
 *     development server on Windows", affects >= 0.27.3 < 0.28.1). Pulled in by
 *     tsup > bundle-require; development-only.
 *
 * Both are fixed by an `overrides` entry in package.json. The @babel/core
 * override deliberately stays inside the 7.x major that @opentui/solid chose, so
 * we raise the patch level without substituting a different framework
 * generation than the upstream package was built against.
 *
 * These tests exist so the overrides cannot be dropped, and so a future
 * dependency bump cannot quietly reintroduce a vulnerable copy under a nested
 * resolution.
 */

interface Advisory {
  /** Package name as it appears in package.json / bun.lock. */
  name: string
  /** The override we require, and the advisory it closes. */
  override: string
  advisory: string
  /** Every resolved version must satisfy this. */
  isFixed: (version: string) => boolean
  /** Human-readable statement of the affected range, for failure messages. */
  affected: string
}

function compare(a: string, b: string): number {
  const pa = a.split(".").map(Number)
  const pb = b.split(".").map(Number)
  for (let i = 0; i < 3; i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

const ADVISORIES: Advisory[] = [
  {
    name: "@babel/core",
    override: "7.29.7",
    advisory: "GHSA-4x5r-pxfx-6jf8",
    affected: "<= 7.29.0",
    isFixed: (version) => compare(version, "7.29.0") > 0,
  },
  {
    name: "esbuild",
    override: "0.28.2",
    advisory: "GHSA-g7r4-m6w7-qqqr",
    affected: ">= 0.27.3 < 0.28.1",
    isFixed: (version) => compare(version, "0.27.3") < 0 || compare(version, "0.28.1") >= 0,
  },
]

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  overrides?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}
const lockfile = readFileSync(join(ROOT, "bun.lock"), "utf8")

/**
 * Every version bun resolved for `name`, including nested copies. bun.lock keys
 * each resolution as `"<name>@<version>"` in the entry tuple, so a scan over the
 * whole file catches duplicates that a top-level lookup would miss.
 */
function resolvedVersions(name: string): string[] {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const matches = lockfile.matchAll(new RegExp(`"${escaped}@([0-9][^"]*)"`, "g"))
  return [...new Set([...matches].map((match) => match[1]!))]
}

describe("transitive security advisory overrides", () => {
  test.each(ADVISORIES)("package.json pins $name to close $advisory", (entry) => {
    expect(pkg.overrides?.[entry.name]).toBe(entry.override)
  })

  test.each(ADVISORIES)("the lockfile resolves $name only to a fixed version", (entry) => {
    const versions = resolvedVersions(entry.name)
    expect(versions.length).toBeGreaterThan(0)
    const vulnerable = versions.filter((version) => !entry.isFixed(version))
    expect(vulnerable, `${entry.name} ${entry.affected} is affected by ${entry.advisory}`).toEqual(
      [],
    )
  })

  test.each(ADVISORIES)("the $name override is itself a fixed version", (entry) => {
    expect(entry.isFixed(entry.override)).toBe(true)
  })

  test("the @babel/core override stays inside the major @opentui/solid depends on", () => {
    // Substituting a different Babel major than the upstream package was built
    // against would trade a low-severity advisory for a compatibility risk in
    // the runtime closure. Raise the patch level, never the major.
    expect(pkg.overrides?.["@babel/core"]).toMatch(/^7\./)
  })

  test("overrides are not used to mask a direct dependency we control", () => {
    // A direct dependency should be bumped in place; an override here would
    // hide the real version from `package.json` readers.
    const direct = { ...pkg.dependencies, ...pkg.devDependencies }
    for (const name of Object.keys(pkg.overrides ?? {})) {
      expect(direct[name]).toBeUndefined()
    }
  })
})
