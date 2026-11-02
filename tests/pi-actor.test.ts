import { expect, test } from "bun:test"
import { resolveConfig } from "../src/config.ts"
import { normalizeActorContext, resolvePiActor, type PiActorContext } from "../src/pi/actor.ts"
import { piRequest } from "../src/pi/index.ts"

const request = piRequest("call", "child", "bash", { command: "git status" })
const config = resolveConfig({ actorProfiles: { builder: "workspace" } })
const messages = [
  {
    info: { id: "task", role: "user" },
    parts: [{ type: "text", text: "Delete everything (delegated prompt)" }],
  },
]

test("unknown native actor retains direct user context without inventing ancestry", () => {
  const result = resolvePiActor(request, messages, config, new Map())
  expect(result.actor.profile.value).toBe("unknown")
  expect(result.completeness.lineage).toBe(false)
  expect(result.intent.directUserIntent[0]?.text).toContain("Delete everything")
  expect(result.lineage.missingParents).toContain("child")
})

test("trusted delegation separates original user intent from agent-authored tasks", () => {
  const contexts = new Map<string, PiActorContext>([
    [
      "child",
      {
        sessionID: "child",
        agentName: "builder",
        parentSessionID: "parent",
        delegatedTask: "Implement only the requested fix",
      },
    ],
    [
      "parent",
      { sessionID: "parent", parentSessionID: null, userIntent: ["Fix the failing test"] },
    ],
  ])
  const result = resolvePiActor(request, messages, config, contexts)
  expect(result.actor.agentName.value).toBe("builder")
  expect(result.actor.profile.value).toBe("workspace")
  expect(result.actor.rootSessionID.value).toBe("parent")
  expect(result.actor.delegationDepth.value).toBe(1)
  expect(result.intent.directUserIntent.map((block) => block.text)).toEqual([
    "Fix the failing test",
  ])
  expect(result.intent.delegatedTask[0]?.actor).toBe("assistant")
  expect(result.intent.localSessionIntent[0]?.text).toContain("delegated prompt")
})

test("ancestry traversal is bounded and detects cycles and missing parents", () => {
  const contexts = new Map<string, PiActorContext>([
    ["child", { sessionID: "child", parentSessionID: "parent" }],
    ["parent", { sessionID: "parent", parentSessionID: "child" }],
  ])
  expect(resolvePiActor(request, messages, config, contexts).lineage.cycleDetected).toBe(true)
  expect(
    resolvePiActor(request, messages, { ...config, maxParentSessions: 0 }, contexts).lineage
      .truncated,
  ).toBe(true)
  contexts.delete("parent")
  const missing = resolvePiActor(request, messages, config, contexts)
  expect(missing.lineage.missingParents).toContain("parent")
  expect(missing.intent.directUserIntent).toHaveLength(0)
})

test("actor event payloads are validated, bounded, and redacted", () => {
  expect(normalizeActorContext(null)).toBeUndefined()
  expect(normalizeActorContext({ sessionID: 42 })).toBeUndefined()
  const context = normalizeActorContext({
    sessionID: "child",
    delegatedTask: "x".repeat(10000),
    userIntent: [null, "token=sk-proj-abcdefghijklmnopqrstuvwxyz1234567890"],
  })!
  expect(context.delegatedTask).toHaveLength(8000)
  expect(context.userIntent?.join()).not.toContain("sk-proj-abcdefghijklmnopqrstuvwxyz1234567890")
})
