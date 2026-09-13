import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const WORKFLOW = join(import.meta.dirname, "..", ".github", "workflows", "release.yml")

/**
 * The release job holds `contents: write`, `id-token: write`,
 * `attestations: write`, and the npm publish token. An action referenced by a
 * mutable tag can be force-moved to arbitrary code and would publish with all
 * of that authority, so every reference must be a full commit SHA.
 */
describe("release workflow action pinning", () => {
  const workflow = readFileSync(WORKFLOW, "utf8")
  const uses = [...workflow.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map((m) => m[1]!)

  test("the workflow actually references actions", () => {
    expect(uses.length).toBeGreaterThan(0)
  })

  test("every action is pinned to a full 40-character commit SHA", () => {
    const unpinned = uses.filter((ref) => !/@[0-9a-f]{40}$/.test(ref))
    expect(unpinned).toEqual([])
  })

  test("every pinned action records its human-readable version in a comment", () => {
    const pinnedLines = [...workflow.matchAll(/^\s*-?\s*uses:\s*\S+@[0-9a-f]{40}(.*)$/gm)].map(
      (m) => m[1]!,
    )
    expect(pinnedLines).toHaveLength(uses.length)
    for (const trailer of pinnedLines) expect(trailer.trim()).toMatch(/^# v\d/)
  })
})
