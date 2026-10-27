import { expect, test } from "bun:test"
import { resolveConfig } from "../src/config.ts"
import { applyModeCommand, MODE_COMMAND } from "../src/runtime-mode.ts"
import { ApprovalReviewerRuntime } from "../src/runtime.ts"
import { decision, MockClient, request, runtime } from "./helpers.ts"

const command = (action: string) => ({
  type: "tui.command.execute",
  properties: { command: `${MODE_COMMAND}${action}` },
})

test("live toggles change subsequent decisions without restarting the runtime", async () => {
  const config = resolveConfig({ mode: "automatic" })
  const client = new MockClient()
  client.nextStructured = decision("escalate", { rationale: "Needs narrower scope." })
  const harness = runtime(client)
  const reviewer = new ApprovalReviewerRuntime(harness.ctx, config)
  expect((await reviewer.process(request())).kind).toBe("deny")
  expect(applyModeCommand(config, command("toggle"))).toBe(`${MODE_COMMAND}changed.human-review`)
  expect((await reviewer.process(request({ id: "second" }))).kind).toBe("escalate")
  expect(client.replies).toHaveLength(1)
  applyModeCommand(config, command("toggle"))
  expect((await reviewer.process(request({ id: "third" }))).kind).toBe("deny")
  expect(client.replies).toHaveLength(2)
})

test("mode queries and acknowledgments never toggle or loop", () => {
  const config = resolveConfig({ mode: "human-review" })
  const response = applyModeCommand(config, command("get"))
  expect(response).toBe(`${MODE_COMMAND}state.human-review`)
  expect(applyModeCommand(config, command("state.human-review"))).toBeUndefined()
  expect(applyModeCommand(config, command("changed.automatic"))).toBeUndefined()
  expect(
    applyModeCommand(config, { ...command("toggle"), type: "message.updated" }),
  ).toBeUndefined()
  expect(config.mode).toBe("human-review")
  applyModeCommand(config, command("automatic"))
  expect(config.escalationMode).toBe("deny")
  applyModeCommand(config, command("human-review"))
  expect(config.escalationMode).toBe("manual")
})
