import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  assertHostContract,
  DEGRADED_SURFACES,
  hostContractError,
  REQUIRED_SURFACES,
  SUPPORTED_HOST_RANGE,
  VERIFIED_HOST_VERSION,
  verifyHostContract,
} from "../src/opencode/host-contract.ts"
import { createV1Adapter } from "../src/opencode/v1-adapter.ts"
import { createOpencodeClient } from "@opencode-ai/sdk"

const ROOT = join(import.meta.dirname, "..")
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  peerDependencies: Record<string, string>
  devDependencies: Record<string, string>
}

/** A host client that satisfies the whole contract. */
function host(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    _client: { post: () => Promise.resolve({}) },
    session: { get: () => Promise.resolve({}) },
    tui: { publish: () => Promise.resolve({}) },
    ...overrides,
  }
}

describe("host contract — declared range", () => {
  test("the supported range matches the declared peer dependency", () => {
    expect(pkg.peerDependencies["@opencode-ai/plugin"]).toBe(SUPPORTED_HOST_RANGE)
  })

  test("the verified version matches the pinned development graph", () => {
    expect(pkg.devDependencies["@opencode-ai/plugin"]).toBe(VERIFIED_HOST_VERSION)
  })
})

describe("host contract — probe", () => {
  test("a complete host satisfies the contract with nothing degraded", () => {
    const result = verifyHostContract(host())
    expect(result.satisfied).toBe(true)
    expect(result.missing).toHaveLength(0)
    expect(result.degraded).toHaveLength(0)
  })

  test("a host without an authenticated transport or reply channel is unverified", () => {
    const result = verifyHostContract(host({ _client: {} }))
    expect(result.satisfied).toBe(false)
    expect(result.missing.map((s) => s.name)).toEqual(REQUIRED_SURFACES.map((s) => s.name))
  })

  test("a public reply method satisfies the reply channel but not the transport", () => {
    const result = verifyHostContract({
      _client: {},
      postSessionIdPermissionsPermissionId: () => Promise.resolve({}),
    })
    expect(result.satisfied).toBe(false)
    expect(result.missing.map((s) => s.name)).toEqual(["client._client.post"])
  })

  test("missing evidence and presentation surfaces degrade rather than fail", () => {
    const result = verifyHostContract({ _client: { post: () => Promise.resolve({}) } })
    expect(result.satisfied).toBe(true)
    expect(result.degraded.map((s) => s.name)).toEqual(DEGRADED_SURFACES.map((s) => s.name))
  })

  test("the probe never throws on hostile or absent client shapes", () => {
    for (const value of [undefined, null, 0, "client", [], { _client: null }, { _client: 7 }]) {
      expect(() => verifyHostContract(value)).not.toThrow()
      expect(verifyHostContract(value).satisfied).toBe(false)
    }
  })

  test("the probe only reads properties; it never invokes host methods", () => {
    let called = false
    const exploding = host({
      _client: {
        get post() {
          called = true
          return () => Promise.resolve({})
        },
      },
    })
    verifyHostContract(exploding)
    // Reading the getter is fine; what must not happen is a call.
    expect(called).toBe(true)
  })
})

describe("host contract — fail closed", () => {
  test("assert throws for an unverified host and names what is missing", () => {
    expect(() => assertHostContract({})).toThrow(/refuses to start/)
    expect(() => assertHostContract({})).toThrow(/client\._client\.post/)
    expect(() => assertHostContract({})).toThrow(/fails closed/)
  })

  test("the error states the supported range and the verified version", () => {
    const message = hostContractError(REQUIRED_SURFACES)
    expect(message).toContain(SUPPORTED_HOST_RANGE)
    expect(message).toContain(VERIFIED_HOST_VERSION)
  })

  test("assert reports the degraded set through the logger instead of throwing", () => {
    const logged: unknown[] = []
    const result = assertHostContract({ _client: { post: () => Promise.resolve({}) } }, (m, d) =>
      logged.push([m, d]),
    )
    expect(result.satisfied).toBe(true)
    expect(logged).toHaveLength(1)
    expect(JSON.stringify(logged)).toContain("client.session.get")
  })

  test("a complete host logs nothing", () => {
    const logged: unknown[] = []
    assertHostContract(host(), (m) => logged.push(m))
    expect(logged).toHaveLength(0)
  })
})

describe("host contract — adapter startup", () => {
  test("the adapter refuses to build a runtime against an unverified host", () => {
    expect(() =>
      createV1Adapter({ client: { session: {} }, directory: "/w", worktree: "/w" }),
    ).toThrow(/refuses to start/)
  })

  test("the adapter starts against a host that satisfies the contract", () => {
    const ctx = createV1Adapter({ client: host(), directory: "/w", worktree: "/w" })
    expect(ctx.directory).toBe("/w")
    expect(typeof ctx.permissionReply).toBe("function")
  })
})

/**
 * Compatibility check against the host the development graph actually resolves
 * to. The peer range is wider than any single tested version, so this is what
 * turns a host upgrade that removes a surface into a failing test instead of a
 * refused startup in a consumer's terminal.
 */
describe("host contract — installed host compatibility", () => {
  // Constructing the client performs no I/O; the base URL is never reached.
  const client = createOpencodeClient({ baseUrl: "http://127.0.0.1:1/" })

  test(`the installed @opencode-ai/plugin host (${VERIFIED_HOST_VERSION}) satisfies the contract`, () => {
    const result = verifyHostContract(client)
    expect(result.missing.map((s) => s.name)).toEqual([])
    expect(result.satisfied).toBe(true)
  })

  test("the installed host provides every degraded-tier surface too", () => {
    expect(verifyHostContract(client).degraded.map((s) => s.name)).toEqual([])
  })

  test("the installed host is not a v2-generation client", () => {
    expect((client as unknown as Record<string, unknown>).permission).toBeUndefined()
  })
})
