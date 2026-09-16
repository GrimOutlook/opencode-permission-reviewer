import { afterEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const ROOT = join(import.meta.dirname, "..")
const SCRIPT = join(ROOT, "scripts", "compare-package-tarballs.sh")
const WORKFLOW = readFileSync(join(ROOT, ".github", "workflows", "release.yml"), "utf8")

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

async function fixture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "published-artifact-"))
  directories.push(directory)
  return directory
}

/** Build an npm-shaped tarball (contents rooted at `package/`) in `directory`. */
async function pack(
  directory: string,
  name: string,
  files: Record<string, string>,
): Promise<string> {
  const staging = join(directory, `${name}-src`, "package")
  await mkdir(staging, { recursive: true })
  for (const [relative, contents] of Object.entries(files)) {
    const target = join(staging, relative)
    await mkdir(join(target, ".."), { recursive: true })
    await writeFile(target, contents)
  }
  const tarball = join(directory, `${name}.tgz`)
  const packed = spawnSync("tar", [
    "-czf",
    tarball,
    "-C",
    join(directory, `${name}-src`),
    "package",
  ])
  expect(packed.status).toBe(0)
  return tarball
}

function compare(...args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(SCRIPT, args, { encoding: "utf8" })
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr }
}

const BASE = {
  "package.json": '{"name":"demo","version":"1.0.0"}\n',
  "dist/index.js": "export const x = 1\n",
  "README.md": "# demo\n",
}

describe("published artifact comparison", () => {
  test("accepts two packs with identical contents", async () => {
    const directory = await fixture()
    const a = await pack(directory, "a", BASE)
    // Packed separately, so gzip framing and mtimes differ from `a`.
    const b = await pack(directory, "b", BASE)
    const result = compare(a, b)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("matches the inspected tarball (3 files)")
  })

  test("rejects a published tarball whose file contents differ", async () => {
    const directory = await fixture()
    const a = await pack(directory, "a", BASE)
    const b = await pack(directory, "b", { ...BASE, "dist/index.js": "export const x = 666\n" })
    const result = compare(a, b)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("does not match the inspected tarball")
  })

  test("rejects a published tarball carrying an extra file", async () => {
    const directory = await fixture()
    const a = await pack(directory, "a", BASE)
    const b = await pack(directory, "b", { ...BASE, "dist/postinstall.js": "steal()\n" })
    expect(compare(a, b).status).toBe(1)
  })

  test("rejects a published tarball missing a file", async () => {
    const directory = await fixture()
    const a = await pack(directory, "a", BASE)
    const b = await pack(directory, "b", { "package.json": BASE["package.json"] })
    expect(compare(a, b).status).toBe(1)
  })

  test("writes the verified manifest when an output path is given", async () => {
    const directory = await fixture()
    const a = await pack(directory, "a", BASE)
    const b = await pack(directory, "b", BASE)
    const manifest = join(directory, "manifest.txt")
    expect(compare(a, b, manifest).status).toBe(0)
    const contents = readFileSync(manifest, "utf8")
    expect(contents).toContain("./dist/index.js")
    expect(contents.trim().split("\n")).toHaveLength(3)
  })

  test("fails closed on a missing tarball and on a non-npm tarball", async () => {
    const directory = await fixture()
    const a = await pack(directory, "a", BASE)
    expect(compare(a, join(directory, "absent.tgz")).status).toBe(1)

    const strayDirectory = join(directory, "stray")
    await mkdir(join(strayDirectory, "not-package"), { recursive: true })
    await writeFile(join(strayDirectory, "not-package", "x"), "x")
    const stray = join(directory, "stray.tgz")
    spawnSync("tar", ["-czf", stray, "-C", strayDirectory, "not-package"])
    expect(compare(a, stray).status).toBe(1)
  })
})

describe("release workflow publishes what it inspected", () => {
  test("the workflow verifies the registry artifact after publishing", () => {
    const publish = WORKFLOW.indexOf("npm publish")
    const verify = WORKFLOW.indexOf("compare-package-tarballs.sh")
    expect(publish).toBeGreaterThan(-1)
    expect(verify).toBeGreaterThan(publish)
    expect(WORKFLOW).toContain('npm view "$spec" dist.integrity')
  })

  test("the verification record is attached to the GitHub Release", () => {
    expect(WORKFLOW).toContain("artifacts/published-artifact.txt \\")
    expect(WORKFLOW).toContain("artifacts/published-contents-sha256.txt \\")
  })
})
