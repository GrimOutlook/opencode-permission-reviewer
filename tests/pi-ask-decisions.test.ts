import { expect, test } from "bun:test"
import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent"
import { resolveConfig } from "../src/config.ts"
import {
  PiAskDecisions,
  registerAskDecisions,
  PI_ASK_DECISION_EVENT,
} from "../src/pi/ask-decisions.ts"

test("ask answers are bounded, redacted, and scoped to current/ancestor sessions", () => {
  const registry = new PiAskDecisions()
  registry.record({ sessionID: "parent", question: "Deploy?", answer: "Only staging" })
  registry.record({ sessionID: "sibling", question: "Deploy prod?", answer: "Yes" })
  registry.record({
    sessionID: "child",
    question: "Token?",
    answer: "sk-proj-abcdefghijklmnopqrstuvwxyz1234567890",
  })
  registry.record({ sessionID: "child", question: 42, answer: "ignored" })
  const answers = registry.recentFor(["child", "parent"])
  expect(answers).toHaveLength(2)
  expect(answers.map((answer) => answer.answer).join()).toContain("Only staging")
  expect(answers.map((answer) => answer.answer).join()).not.toContain("Yes")
  expect(JSON.stringify(answers)).not.toContain("sk-proj-abcdefghijklmnopqrstuvwxyz1234567890")
  for (let i = 0; i < 25; i++)
    registry.record({ sessionID: "child", question: "bounded", answer: "x".repeat(3000) })
  expect(registry.recentFor(["child"])).toHaveLength(20)
  expect(registry.recentFor(["child"])[0]?.answer).toHaveLength(2000)
})

test("question tool captures actual UI answers and dismissals; headless calls fail closed", async () => {
  let tool!: Parameters<ExtensionAPI["registerTool"]>[0]
  let event!: (payload: unknown) => void
  let enabled = true
  const registry = registerAskDecisions(
    {
      registerTool: (definition: typeof tool) => {
        tool = definition
      },
      events: {
        on: (name: string, handler: typeof event) => {
          expect(name).toBe(PI_ASK_DECISION_EVENT)
          event = handler
        },
      },
    } as unknown as ExtensionAPI,
    () => ({ ...resolveConfig({}), askDecisions: enabled }),
  )
  const ctx = {
    hasUI: true,
    sessionManager: { getSessionId: () => "child" },
    ui: { input: async () => "Only staging", select: async () => undefined },
  } as unknown as ExtensionToolContext
  await tool.execute("call", { question: "Deploy where?" }, undefined, undefined, ctx)
  expect(registry.recentFor(["child"])[0]?.answer).toBe("Only staging")
  await tool.execute(
    "call2",
    { question: "Deploy now?", options: ["Yes", "No"] },
    undefined,
    undefined,
    ctx,
  )
  expect(registry.recentFor(["child"])[1]?.answer).toBe("Dismissed by user")
  await expect(
    tool.execute("call3", { question: "Deploy?" }, undefined, undefined, { ...ctx, hasUI: false }),
  ).rejects.toThrow("requires an available")
  enabled = false
  event({ sessionID: "child", question: "No capture", answer: "Yes" })
  await tool.execute("call4", { question: "No capture" }, undefined, undefined, ctx)
  expect(registry.recentFor(["child"])).toHaveLength(2)
})
