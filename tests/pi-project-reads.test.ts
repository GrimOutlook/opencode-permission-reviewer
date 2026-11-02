import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isOrdinaryProjectRead } from "../src/pi/project-reads.ts"
import { loadPiConfig, piRequest } from "../src/pi/index.ts"

test("project read fast path checks real paths, sensitive files, and regular-file status", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-read-scope-"))
  const project = join(root, "project")
  const other = join(root, "project-other")
  try {
    await mkdir(project)
    await mkdir(other)
    await mkdir(join(project, "secrets"))
    await mkdir(join(project, ".pi"))
    await writeFile(join(project, "safe.txt"), "ordinary source")
    await writeFile(join(other, "outside.txt"), "external")
    await writeFile(join(project, ".env.local"), "sensitive")
    await writeFile(join(project, "secrets/config.txt"), "sensitive")
    await writeFile(join(project, "private.key"), "sensitive")
    await symlink(join(project, "safe.txt"), join(project, "inside-link"))
    await symlink(join(other, "outside.txt"), join(project, "outside-link"))
    await symlink(join(project, ".env.local"), join(project, "hidden-secret"))
    const check = (path: string, permission = "read") =>
      isOrdinaryProjectRead(piRequest("call", "session", permission, { path }), project)
    expect(await check("safe.txt")).toBe(true)
    expect(await check(join(project, "safe.txt"))).toBe(true)
    expect(await check("inside-link")).toBe(true)
    for (const path of [
      "../project-other/outside.txt",
      "outside-link",
      "hidden-secret",
      ".env.local",
      "secrets/config.txt",
      "private.key",
      ".pi",
      "missing",
      ".",
      "~/safe.txt",
      "@safe.txt",
      "file:///etc/passwd",
      "safe\u00a0.txt",
    ]) {
      expect(await check(path)).toBe(false)
    }
    for (const tool of ["bash", "grep", "find", "ls", "write", "edit"])
      expect(await check("safe.txt", tool)).toBe(false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("project-read policy defaults on and validates the personal-config opt-out", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-read-config-"))
  const path = join(root, "config.json")
  try {
    expect(loadPiConfig(path).allowProjectReads).toBe(true)
    await writeFile(path, JSON.stringify({ allowProjectReads: false }))
    expect(loadPiConfig(path).allowProjectReads).toBe(false)
    await writeFile(path, JSON.stringify({ allowProjectReads: "false" }))
    expect(() => loadPiConfig(path)).toThrow("allowProjectReads must be a boolean")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
