import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const WORKFLOW = join(import.meta.dirname, "..", ".github", "workflows", "release.yml")
const workflow = readFileSync(WORKFLOW, "utf8")

/**
 * A pushed `v*` tag is only a *request* to release. The version check compares
 * the tag name against package.json, which any commit's contents would pass, so
 * the workflow must additionally refuse anything that is not already on the
 * protected release branch before it installs dependencies or publishes.
 */
describe("release tag authorization", () => {
  test("the release job verifies the tag commit is reachable from the release branch", () => {
    expect(workflow).toContain("git merge-base --is-ancestor")
    expect(workflow).toMatch(/RELEASE_BRANCH:\s*main/)
  })

  test("the check fails the job rather than warning", () => {
    const step = workflow.slice(workflow.indexOf("Verify tag commit is reachable"))
    const body = step.slice(0, step.indexOf("\n      - name:"))
    expect(body).toContain("exit 1")
    expect(body).toContain("set -euo pipefail")
  })

  test("authorization runs before dependency install, build, and publish", () => {
    // Order the *steps*, not the file: the header comments mention the publish
    // token and the pinning policy, and matching those would make the ordering
    // assertion depend on prose.
    const steps = workflow.slice(workflow.indexOf("\n    steps:"))
    const guard = steps.indexOf("Verify tag commit is reachable")
    expect(guard).toBeGreaterThan(-1)
    for (const later of ["bun install", "bun run check", "npm publish"]) {
      expect(steps.indexOf(later)).toBeGreaterThan(guard)
    }
  })

  test("checkout fetches full history so reachability can be evaluated", () => {
    expect(workflow).toContain("fetch-depth: 0")
  })
})
