import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

const ROOT = join(import.meta.dirname, "..")
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  dependencies: Record<string, string>
  devDependencies: Record<string, string>
  peerDependencies: Record<string, string>
}
const policy = readFileSync(join(ROOT, "DEPENDENCIES.md"), "utf8")
const lockText = readFileSync(join(ROOT, "bun.lock"), "utf8")

/** `bun.lock` is JSONC; strip trailing commas without touching string bodies. */
function parseLockfile(text: string): { packages: Record<string, unknown[]> } {
  let out = ""
  let inString = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!
    if (inString) {
      out += ch
      if (ch === "\\") {
        out += text[i + 1] ?? ""
        i += 1
      } else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      continue
    }
    if (ch === ",") {
      let j = i + 1
      while (j < text.length && /\s/.test(text[j]!)) j += 1
      if (text[j] === "}" || text[j] === "]") continue
    }
    out += ch
  }
  return JSON.parse(out) as { packages: Record<string, unknown[]> }
}

const lock = parseLockfile(lockText)

interface Entry {
  name: string
  version: string
  dependencies: string[]
}

const entries = new Map<string, Entry>()
for (const [key, value] of Object.entries(lock.packages)) {
  const spec = typeof value[0] === "string" ? value[0] : `${key}@unknown`
  const at = spec.lastIndexOf("@")
  const meta = (typeof value[2] === "object" && value[2] !== null ? value[2] : {}) as Record<
    string,
    unknown
  >
  const named = (field: string): string[] => {
    const record = meta[field]
    return typeof record === "object" && record !== null ? Object.keys(record) : []
  }
  const entry: Entry = {
    name: at > 0 ? spec.slice(0, at) : spec,
    version: at > 0 ? spec.slice(at + 1) : "unknown",
    // Peer dependencies are supplied by the host and are deliberately excluded:
    // they are the trust boundary, not part of this package's closure.
    dependencies: [...named("dependencies"), ...named("optionalDependencies")],
  }
  entries.set(key, entry)
  if (!entries.has(entry.name)) entries.set(entry.name, entry)
}

function closure(roots: string[]): Set<string> {
  const seen = new Set<string>()
  const queue = [...roots]
  while (queue.length > 0) {
    const name = queue.shift()!
    if (seen.has(name)) continue
    seen.add(name)
    queue.push(...(entries.get(name)?.dependencies ?? []))
  }
  return seen
}

/** Semver prerelease: a hyphen after the patch component. */
function isPrerelease(version: string): boolean {
  return /^[0-9]+\.[0-9]+\.[0-9]+-/.test(version)
}

const runtime = closure(Object.keys(pkg.dependencies))

/**
 * Prereleases the runtime closure is allowed to reach, each documented in
 * DEPENDENCIES.md. `gensync@1.0.0-beta.2` is Babel's long-standing published
 * `latest` — a prerelease by version string only — reached through
 * @opentui/solid's Babel pipeline. Anything new here is a review step.
 */
const KNOWN_RUNTIME_PRERELEASES = ["gensync@1.0.0-beta.2"]

/**
 * `effect@4.0.0-beta.83` arrives through @opencode-ai/plugin, which every
 * current release pins to the same prerelease. It is a documented exception
 * (see DEPENDENCIES.md); these tests keep the conditions that make it
 * acceptable from eroding unnoticed.
 */
describe("prerelease dependency exception", () => {
  test("effect is present in the development graph, as documented", () => {
    const effect = entries.get("effect")
    expect(effect).toBeDefined()
    expect(isPrerelease(effect!.version)).toBe(true)
  })

  test("the documented Effect version matches the lockfile", () => {
    expect(policy).toContain(`4.0.0-beta.83`)
    expect(entries.get("effect")!.version).toBe("4.0.0-beta.83")
  })

  test("effect never becomes a direct dependency of this package", () => {
    expect(pkg.dependencies.effect).toBeUndefined()
    expect(pkg.devDependencies.effect).toBeUndefined()
    expect(pkg.peerDependencies.effect).toBeUndefined()
  })

  test("effect is not reachable from the runtime dependency closure", () => {
    expect(runtime.has("effect")).toBe(false)
    expect(runtime.has("@opencode-ai/plugin")).toBe(false)
  })

  test("the runtime closure reaches only the documented prereleases", () => {
    const prereleases = [...runtime]
      .map((name) => entries.get(name))
      .filter((entry): entry is Entry => entry !== undefined && isPrerelease(entry.version))
      .map((entry) => `${entry.name}@${entry.version}`)
      .sort()
    expect(prereleases).toEqual(KNOWN_RUNTIME_PRERELEASES)
    for (const spec of prereleases) expect(policy).toContain(spec)
  })

  test("the OpenCode host packages stay development/peer only", () => {
    for (const name of ["@opencode-ai/plugin", "@opencode-ai/sdk"]) {
      expect(pkg.dependencies[name]).toBeUndefined()
    }
    expect(pkg.peerDependencies["@opencode-ai/plugin"]).toBeDefined()
  })

  test("the published bundle contains no Effect code", () => {
    const bundle = join(ROOT, "dist", "index.js")
    if (!existsSync(bundle)) return // dist/ is generated; skip when not built.
    const contents = readFileSync(bundle, "utf8")
    expect(contents).not.toContain("node_modules/effect")
    expect(contents).not.toMatch(/from\s+["']effect["']/)
  })
})
