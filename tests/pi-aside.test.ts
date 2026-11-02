import { expect, test } from "bun:test"
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent"
import { ASIDE_ENTRY, registerAside, TaskStatusTracker } from "../src/pi/aside.ts"

function harness() {
  let command!: Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]
  const events = new Map<string, (event: unknown, ctx: unknown) => Promise<void>>()
  const entries: Array<{ type: string; text: string }> = []
  let sessionID = "session"
  let modelContext:
    | {
        systemPrompt: string
        messages: Array<{ content: Array<{ text: string }> }>
        tools: unknown[]
      }
    | undefined
  let result: () => Promise<unknown> = async () => ({
    stopReason: "stop",
    content: [
      { type: "text", text: "The tests have reached case 10; there is no completion estimate." },
    ],
  })
  let calls = 0
  const tracker = registerAside({
    registerEntryRenderer: () => {},
    registerCommand: (name: string, options: { handler: typeof command }) => {
      expect(name).toBe("aside")
      command = options.handler
    },
    on: (name: string, callback: (event: unknown, ctx: unknown) => Promise<void>) => {
      events.set(name, callback)
    },
    appendEntry: (type: string, data: { text: string }) => entries.push({ type, text: data.text }),
  } as unknown as ExtensionAPI)
  const ctx = {
    sessionManager: {
      getSessionId: () => sessionID,
      getBranch: () => [
        { type: "message", id: "user", message: { role: "user", content: "Run the test suite" } },
        {
          type: "message",
          id: "tool",
          message: {
            role: "toolResult",
            toolName: "read",
            toolCallId: "earlier",
            isError: false,
            content: [{ type: "text", text: "Project uses pytest" }],
          },
        },
        {
          type: "custom",
          customType: ASIDE_ENTRY,
          data: { text: "Previous aside: tests exercise the parser." },
        },
      ],
    },
    model: { id: "test", reasoning: false },
    modelRegistry: {
      streamSimple: (_model: unknown, context: NonNullable<typeof modelContext>) => {
        calls++
        modelContext = context
        return { result }
      },
    },
    ui: { notify: () => {} },
  } as unknown as ExtensionCommandContext
  return {
    tracker,
    entries,
    ctx,
    ask: (question: string) => command(question, ctx),
    emit: (name: string, event: unknown) => events.get(name)!(event, ctx),
    switchSession: (id: string) => {
      sessionID = id
    },
    setResult: (fn: typeof result) => {
      result = fn
    },
    get modelContext() {
      return modelContext
    },
    get calls() {
      return calls
    },
  }
}

test("task tracker reports pending/running/completed state and bounded cumulative output", () => {
  const tracker = new TaskStatusTracker()
  tracker.start("one", "call", "bash", { command: "pytest" })
  expect(tracker.snapshot("one")).toContain("awaiting review")
  tracker.phase("one", "call", "running")
  tracker.update("one", "call", { content: [{ type: "text", text: "case 1" }] })
  tracker.update("one", "call", { content: [{ type: "text", text: "case 1\ncase 2" }] })
  const running = tracker.snapshot("one")
  expect(running).toContain("running")
  expect(running.match(/case 1/g)).toHaveLength(1)
  expect(tracker.snapshot("two")).not.toContain("pytest")
  tracker.update(
    "one",
    "call",
    {
      content: [
        {
          type: "text",
          text: "x".repeat(20000) + " token=sk-proj-abcdefghijklmnopqrstuvwxyz1234567890",
        },
      ],
    },
    true,
  )
  expect(tracker.snapshot("one")).toContain("completed")
  expect(tracker.snapshot("one").length).toBeLessThan(17000)
  expect(tracker.snapshot("one")).not.toContain("sk-proj-abcdefghijklmnopqrstuvwxyz1234567890")
})

test("plain aside shows a live snapshot without making a model request", async () => {
  const h = harness()
  await h.emit("tool_execution_start", {
    toolCallId: "shell",
    toolName: "bash",
    args: { command: "pytest" },
  })
  h.tracker.phase("session", "shell", "running")
  await h.emit("tool_execution_update", {
    toolCallId: "shell",
    partialResult: { content: [{ type: "text", text: "case 10 passed" }] },
  })
  await h.ask("")
  expect(h.calls).toBe(0)
  expect(h.entries[0]?.type).toBe(ASIDE_ENTRY)
  expect(h.entries[0]?.text).toContain("case 10 passed")
  expect(h.entries[0]?.text).toContain("running")
})

test("aside questions include bounded conversation, previous asides, and live output without tools", async () => {
  const h = harness()
  h.tracker.start("session", "shell", "bash", { command: "pytest" })
  h.tracker.phase("session", "shell", "running")
  h.tracker.update("session", "shell", { content: [{ type: "text", text: "case 10 passed" }] })
  await h.ask("What testing framework is this using, and how far along is it?")
  expect(h.calls).toBe(1)
  expect(h.modelContext?.tools).toEqual([])
  const prompt = h.modelContext!.messages[0]!.content[0]!.text
  expect(prompt).toContain("Run the test suite")
  expect(prompt).toContain("Project uses pytest")
  expect(prompt).toContain("Previous aside")
  expect(prompt).toContain("case 10 passed")
  expect(h.modelContext?.systemPrompt).toContain("does not change the main task")
  expect(h.entries.at(-1)?.text).toContain("no completion estimate")
  expect(h.tracker.snapshot("session")).toContain("running")
})

test("an aside can finish while the main command is still running, and duplicate questions are bounded", async () => {
  const h = harness()
  let resolve!: (value: unknown) => void
  h.setResult(
    () =>
      new Promise((done) => {
        resolve = done
      }),
  )
  h.tracker.start("session", "shell", "bash", { command: "sleep 60" })
  h.tracker.phase("session", "shell", "running")
  const answer = h.ask("What is happening?")
  await h.ask("Another question")
  expect(h.calls).toBe(1)
  await h.ask("")
  expect(h.entries.at(-1)?.text).toContain("running")
  resolve({
    stopReason: "stop",
    content: [{ type: "text", text: "The sleep command is still running." }],
  })
  await answer
  expect(h.entries.at(-1)?.text).toContain("still running")
  expect(h.tracker.snapshot("session")).toContain("running")
})

test("shutdown cancels the aside without appending to a replacement session", async () => {
  const h = harness()
  h.setResult(() => new Promise(() => {}))
  const answer = h.ask("Explain current progress")
  await h.emit("session_shutdown", {})
  h.switchSession("new-session")
  await answer
  expect(h.entries).toHaveLength(0)
  expect(h.tracker.snapshot("session")).toContain("No shell commands tracked")
})
