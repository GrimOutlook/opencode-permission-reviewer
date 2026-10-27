import { describe, expect, test } from "bun:test"
import { resolveConfig } from "../src/config.ts"
import { decision, MockClient, request, runtime } from "./helpers.ts"

describe("review modes", () => {
  test("explicit modes take precedence over legacy escalation settings", () => {
    expect(resolveConfig({ mode: "automatic", escalationMode: "manual" }).escalationMode).toBe(
      "deny",
    )
    expect(resolveConfig({ mode: "human-review", escalationMode: "deny" }).escalationMode).toBe(
      "manual",
    )
    expect(resolveConfig({}).escalationMode).toBe("manual")
  })

  for (const mode of ["automatic", "human-review"] as const) {
    for (const outcome of ["allow", "deny", "escalate"] as const) {
      test(`${mode} handles ${outcome} and sends denial feedback to the agent`, async () => {
        const client = new MockClient()
        client.nextStructured = decision(outcome, { rationale: "Use a narrower command." })
        const harness = runtime(client, resolveConfig({ mode }))
        const result = await harness.runtime.process(request())
        if (outcome === "escalate" && mode === "human-review") {
          expect(result.kind).toBe("escalate")
          expect(client.replies).toHaveLength(0)
          expect(client.uiStatuses.at(-1)?.phase).toBe("manual")
          return
        }
        const denied = outcome !== "allow"
        expect(result.kind).toBe(denied ? "deny" : "allow")
        expect(client.replies).toHaveLength(1)
        expect(client.replies[0]).toMatchObject({
          body: {
            reply: denied ? "reject" : "once",
            ...(denied ? { message: "[Automatic permission review] Use a narrower command." } : {}),
          },
        })
      })
    }

    test(`${mode} handles invalid reviewer output`, async () => {
      const client = new MockClient()
      client.nextStructured = { invalid: true }
      const harness = runtime(client, resolveConfig({ mode }))
      const result = await harness.runtime.process(request())
      expect(result.kind).toBe(mode === "automatic" ? "deny" : "escalate")
      expect(client.replies).toHaveLength(mode === "automatic" ? 1 : 0)
    })
  }
})
