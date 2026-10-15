/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import type { TuiCommand, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { JSX } from "@opentui/solid"
import { HISTORY_KEY } from "../src/review-history.ts"
import { createUiStatus, encodeUiStatus } from "../src/ui-protocol.ts"
import { request } from "./helpers.ts"
import { installReviewHistory, testRender } from "./tui-loader.ts"

const { createMemo, createSignal, Show } = await import("solid-js")

async function setupHistory(stored?: unknown, ready = true) {
  const handlers = new Map<string, Array<(event: never) => void>>()
  const saved = new Map<string, unknown>([[HISTORY_KEY, stored]])
  const [kvReady, setKvReady] = createSignal(ready)
  const [dialog, setDialog] = createSignal<(() => JSX.Element) | undefined>()
  const [sessionID, setSessionID] = createSignal("ses_main")
  let sidebar: (context: object, props: { session_id: string }) => JSX.Element = () => null
  let commands: () => TuiCommand[] = () => []
  let disposed = false
  const api = {
    route: {
      get current() {
        return { name: "session", params: { sessionID: sessionID() } }
      },
    },
    theme: {
      current: {
        success: "#00ff00",
        error: "#ff0000",
        warning: "#ffff00",
        info: "#0000ff",
        text: "#eeeeee",
        textMuted: "#999999",
        accent: "#ff00ff",
        backgroundElement: "#222222",
      },
    },
    kv: {
      get ready() {
        return kvReady()
      },
      get: (key: string) => saved.get(key),
      set: (key: string, value: unknown) => saved.set(key, value),
    },
    state: {
      session: { get: (id: string) => (id === "ses_child" ? { parentID: "ses_main" } : undefined) },
    },
    event: {
      on: (type: string, handler: (event: never) => void) => {
        const list = handlers.get(type) ?? []
        list.push(handler)
        handlers.set(type, list)
        return () => {}
      },
    },
    command: {
      register: (factory: () => TuiCommand[]) => {
        commands = factory
        return () => {
          disposed = true
        }
      },
    },
    lifecycle: {
      onDispose: (fn: () => void) => {
        disposeCommand = fn
      },
    },
    ui: {
      Dialog: (props: { children: JSX.Element }) => (
        <box flexDirection="column">{props.children}</box>
      ),
      dialog: {
        replace: (render: () => JSX.Element) => setDialog(() => render),
        clear: () => setDialog(undefined),
      },
    },
    slots: {
      register: (plugin: { slots: { sidebar_content: typeof sidebar } }) => {
        sidebar = plugin.slots.sidebar_content
      },
    },
  } as unknown as TuiPluginApi
  let disposeCommand = () => {}
  let observer: ReturnType<typeof installReviewHistory>
  const app = await testRender(
    () => {
      observer = installReviewHistory(api, {
        model: "test/model",
        variant: "high",
        timeoutMs: 60_000,
      })
      const content = createMemo(() => sidebar({}, { session_id: sessionID() }))
      return (
        <Show when={dialog()} fallback={<box width={40}>{content()}</box>}>
          {(render) => render()()}
        </Show>
      )
    },
    { width: 100, height: 40 },
  )
  Object.assign(api, { renderer: app.renderer })
  await app.flush()
  return {
    ...app,
    saved,
    commands: () => commands(),
    setKvReady,
    setSessionID,
    observer: observer!,
    dispose: () => {
      disposeCommand()
      app.renderer.destroy()
    },
    disposed: () => disposed,
    fire: (type: string, event: unknown) => {
      for (const handler of handlers.get(type) ?? []) handler(event as never)
    },
  }
}

function review(
  id: string,
  phase: "approved" | "denied" | "manual" = "approved",
  sessionID = "ses_main",
) {
  return createUiStatus(request({ id, sessionID, metadata: { command: `run ${id}` } }), phase, {
    model: "test/model",
    variant: "high",
    timeoutMs: 60_000,
    emittedAt: Number(id.replace("per_", "")) || 100,
    reason: `${"A narrow requested action. ".repeat(8)}End of full rationale.`,
  })
}

function published(status: ReturnType<typeof review>) {
  return { properties: { command: encodeUiStatus(status) } }
}

describe("permission history TUI", () => {
  test("reactively shows three recent reviews, includes children, and isolates sessions", async () => {
    const app = await setupHistory()
    try {
      expect(app.captureCharFrame()).not.toContain("Permission reviews")
      for (let index = 1; index <= 4; index++)
        app.fire("tui.command.execute", published(review(`per_${index}`)))
      app.fire("tui.command.execute", published(review("per_5", "denied", "ses_child")))
      await app.flush()
      const frame = app.captureCharFrame()
      expect(frame).toContain("Permission reviews (5)")
      expect(frame).toContain("$ run per_5")
      expect(frame).toContain("Reviewer denied")
      const spans = app.captureSpans().lines.flatMap((line) => line.spans)
      const commandSpan = spans.find((span) => span.text.includes("run per_5"))
      expect(commandSpan).toBeDefined()
      expect(commandSpan!.bg.r).toBeCloseTo(34 / 255, 2)
      expect(commandSpan!.bg.g).toBeCloseTo(34 / 255, 2)
      const deniedSpan = spans.find((span) => span.text.includes("Reviewer denied"))
      expect(deniedSpan!.fg.r).toBeCloseTo(1)
      expect(deniedSpan!.fg.g).toBeCloseTo(0)
      expect(frame).not.toContain("$ run per_1")
      expect(frame).not.toContain("End of full rationale.")
      app.setSessionID("ses_other")
      await app.flush()
      expect(app.captureCharFrame()).not.toContain("Permission reviews")
    } finally {
      app.dispose()
    }
  })

  test("palette/slash command opens a full-rationale dialog and unregisters on dispose", async () => {
    const app = await setupHistory()
    try {
      app.fire("tui.command.execute", published(review("per_1")))
      await app.flush()
      const command = app.commands()[0]!
      expect(command.slash?.name).toBe("permission-reviews")
      await command.onSelect?.()
      await app.flush()
      const frame = app.captureCharFrame()
      expect(frame).toContain("Permission review history")
      expect(frame).toContain("End of full rationale.")
      expect(frame).toContain("test/model")
      expect(frame).toContain("esc · close")
    } finally {
      app.dispose()
    }
    expect(app.disposed()).toBe(true)
  })

  test("loads saved history after KV hydration and retains new events", async () => {
    const app = await setupHistory(
      { version: 1, entries: [{ status: review("per_1"), ancestors: [] }] },
      false,
    )
    try {
      app.fire("tui.command.execute", published(review("per_2", "manual")))
      expect((app.saved.get(HISTORY_KEY) as { entries: unknown[] }).entries).toHaveLength(1)
      app.setKvReady(true)
      await app.flush()
      expect(app.captureCharFrame()).toContain("Permission reviews (2)")
      expect((app.saved.get(HISTORY_KEY) as { entries: unknown[] }).entries).toHaveLength(2)
    } finally {
      app.dispose()
    }
  })

  test("watchdog escalation and permission replies update the retained card", async () => {
    const app = await setupHistory()
    try {
      app.fire("permission.asked", { type: "permission.asked", properties: request() })
      await app.flush()
      expect(app.captureCharFrame()).toContain("Reviewing permission")
      app.observer.observe({ ...review("per_1", "manual"), emittedAt: Date.now() + 1 })
      await app.flush()
      expect(app.captureCharFrame()).toContain("Manual review required")
      app.fire("permission.replied", {
        properties: { sessionID: "ses_main", requestID: "per_1", reply: "reject" },
      })
      await app.flush()
      expect(app.captureCharFrame()).toContain("Permission denied")
      expect((app.saved.get(HISTORY_KEY) as { entries: unknown[] }).entries).toHaveLength(1)
    } finally {
      app.dispose()
    }
  })
})
