import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const ROOT = join(import.meta.dirname, "..")
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  dependencies: Record<string, string>
  devDependencies: Record<string, string>
}
const policy = readFileSync(join(ROOT, "DEPENDENCIES.md"), "utf8")

/**
 * `bun.lock` is JSONC (trailing commas). Strip them with a scanner that tracks
 * string state, so a comma inside an integrity hash or a package name is never
 * mistaken for a trailing one.
 */
function parseLockfile(text: string): unknown {
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
      // Look ahead past whitespace for a closing bracket.
      let j = i + 1
      while (j < text.length && /\s/.test(text[j]!)) j += 1
      if (text[j] === "}" || text[j] === "]") continue
    }
    out += ch
  }
  return JSON.parse(out)
}

interface Lockfile {
  packages: Record<string, unknown[]>
}

const lock = parseLockfile(readFileSync(join(ROOT, "bun.lock"), "utf8")) as Lockfile

interface Entry {
  name: string
  version: string
  dependencies: string[]
  native: boolean
}

/** Flatten one lockfile entry: ["name@version", registry, meta, integrity]. */
function entryOf(key: string, value: unknown[]): Entry {
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
  return {
    name: at > 0 ? spec.slice(0, at) : spec,
    version: at > 0 ? spec.slice(at + 1) : "unknown",
    dependencies: [...named("dependencies"), ...named("optionalDependencies")],
    // A package constrained to an os or cpu ships platform-specific binaries.
    native: "os" in meta || "cpu" in meta,
  }
}

const entries = new Map<string, Entry>()
for (const [key, value] of Object.entries(lock.packages)) {
  const entry = entryOf(key, value)
  entries.set(key, entry)
  if (!entries.has(entry.name)) entries.set(entry.name, entry)
}

/** Packages that reach native code without an os/cpu constraint of their own. */
const FFI_PACKAGES = new Set(["bun-ffi-structs"])

function closure(roots: string[]): Set<string> {
  const seen = new Set<string>()
  const queue = [...roots]
  while (queue.length > 0) {
    const name = queue.shift()!
    if (seen.has(name)) continue
    seen.add(name)
    const entry = entries.get(name)
    if (!entry) continue
    queue.push(...entry.dependencies)
  }
  return seen
}

function nativeIn(names: Set<string>): string[] {
  return [...names]
    .filter((name) => {
      const entry = entries.get(name)
      return entry !== undefined && (entry.native || FFI_PACKAGES.has(entry.name))
    })
    .sort()
}

/**
 * The trusted native dependency set, mirrored in DEPENDENCIES.md.
 *
 * Native artifacts have a larger compromise and install-time impact surface
 * than ordinary JavaScript packages, so the set a consumer install reaches is
 * enumerated rather than assumed. A package entering it is a deliberate review
 * step, not a silent lockfile change.
 */
const TRUSTED_RUNTIME_NATIVE = [
  "@opentui/core-darwin-arm64",
  "@opentui/core-darwin-x64",
  "@opentui/core-linux-arm64",
  "@opentui/core-linux-arm64-musl",
  "@opentui/core-linux-x64",
  "@opentui/core-linux-x64-musl",
  "@opentui/core-win32-arm64",
  "@opentui/core-win32-x64",
  "bun-ffi-structs",
].sort()

/** Native packages confined to the development graph (build and lint tooling). */
const TRUSTED_DEVELOPMENT_NATIVE_ROOTS = [
  "@esbuild/",
  "@rollup/",
  "@msgpackr-extract/",
  "@napi-rs/",
]
const TRUSTED_DEVELOPMENT_NATIVE_EXACT = ["fsevents"]

describe("native dependency exposure", () => {
  test("the runtime graph reaches exactly the trusted native set", () => {
    expect(nativeIn(closure(Object.keys(pkg.dependencies)))).toEqual(TRUSTED_RUNTIME_NATIVE)
  })

  test("every native package in the lockfile is accounted for", () => {
    const unexpected = [...new Set([...entries.values()].map((e) => e.name))]
      .filter((name) => {
        const entry = entries.get(name)!
        return entry.native || FFI_PACKAGES.has(name)
      })
      .filter(
        (name) =>
          !TRUSTED_RUNTIME_NATIVE.includes(name) &&
          !TRUSTED_DEVELOPMENT_NATIVE_EXACT.includes(name) &&
          !TRUSTED_DEVELOPMENT_NATIVE_ROOTS.some((prefix) => name.startsWith(prefix)),
      )
      .sort()
    expect(unexpected).toEqual([])
  })

  test("development-only native tooling does not leak into the runtime graph", () => {
    const runtime = closure(Object.keys(pkg.dependencies))
    for (const name of [...TRUSTED_DEVELOPMENT_NATIVE_EXACT, "esbuild", "rollup", "tsup"]) {
      expect(runtime.has(name)).toBe(false)
    }
  })

  test("the FFI bridge stays a single, pinned package", () => {
    const bridge = entries.get("bun-ffi-structs")
    expect(bridge).toBeDefined()
    expect(bridge!.version).toMatch(/^[0-9]+\.[0-9]+\.[0-9]+$/)
    expect(policy).toContain(`bun-ffi-structs@${bridge!.version}`)
  })

  test("the policy documents every trusted runtime native package", () => {
    for (const name of TRUSTED_RUNTIME_NATIVE) expect(policy).toContain(name)
  })
})
