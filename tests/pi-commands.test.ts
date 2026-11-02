import { expect, test } from "bun:test"
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent"
import { registerReviewerCommands } from "../src/pi/commands.ts"
import { resolveConfig } from "../src/config.ts"

test("reviewer commands report status, isolate sessions, reset, and reject invalid input", async () => {
  let handler!: Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]
  let session = "first"
  const notices: string[] = []
  const effective = registerReviewerCommands(
    {
      registerCommand: (name: string, options: { handler: typeof handler }) => {
        expect(name).toBe("permission-reviewer")
        handler = options.handler
      },
    } as unknown as ExtensionAPI,
    () => resolveConfig({ escalationMode: "deny" }),
  )
  const ctx = {
    sessionManager: { getSessionId: () => session },
    ui: { notify: (message: string) => notices.push(message) },
  } as unknown as ExtensionCommandContext
  await handler("", ctx)
  expect(notices.at(-1)).toContain("deny (personal configuration)")
  await handler("manual", ctx)
  expect(effective("first").escalationMode).toBe("manual")
  expect(effective("second").escalationMode).toBe("deny")
  await handler("status", ctx)
  expect(notices.at(-1)).toContain("manual (session override)")
  await handler("off", ctx)
  expect(notices.at(-1)).toContain("Usage:")
  expect(effective("first").escalationMode).toBe("manual")
  session = "second"
  await handler("manual", ctx)
  await handler("reset", ctx)
  expect(effective("second").escalationMode).toBe("deny")
  expect(effective("first").escalationMode).toBe("manual")
})
