import { describe, expect, test } from "bun:test"
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent"
import { resolveConfig } from "../src/config.ts"
import { decidePiReview, loadPiConfig, piRequest, registerPiReviewer } from "../src/pi/index.ts"

const verdict = JSON.stringify({
  version: 2,
  outcome: "allow",
  risk_level: "low",
  user_authorization: "high",
  scope_alignment: "aligned",
  evidence_completeness: "sufficient",
  rationale: "Explicitly requested",
  confidence: 0.99,
})
const config = () => ({ ...resolveConfig({ audit: false, escalationMode: "deny" }), model: "" })

function harness(
  complete: () => Promise<unknown>,
  overrides: Record<string, unknown> = {},
  loadConfig = config,
) {
  let handler!: (event: unknown, ctx: ExtensionContext) => Promise<unknown>
  let command!: Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]
  const entries: Array<{ customType: string; data: Record<string, unknown> }> = []
  registerPiReviewer(
    {
      registerEntryRenderer: () => {},
      registerCommand: (_name: string, options: { handler: typeof command }) => {
        command = options.handler
      },
      appendEntry: (customType: string, data: Record<string, unknown>) => {
        entries.push({ customType, data })
      },
      on: (_name: string, callback: typeof handler) => {
        handler = callback
      },
    } as unknown as ExtensionAPI,
    loadConfig,
  )
  const ctx = {
    cwd: process.cwd(),
    hasUI: false,
    model: { id: "test", input: ["text"] },
    sessionManager: { getSessionId: () => "session", getBranch: () => [] },
    modelRegistry: { complete },
    ...overrides,
  } as unknown as ExtensionContext
  return Object.assign(
    () => handler({ toolCallId: "call", toolName: "read", input: { path: "README.md" } }, ctx),
    {
      entries,
      command: (args: string) =>
        command(args, {
          ...ctx,
          ui: { ...ctx.ui, notify: () => {} },
        } as unknown as ExtensionCommandContext),
    },
  )
}

describe("Pi adapter", () => {
  test("normalizes shell requests", () => {
    const request = piRequest("call", "session", "bash", { command: "git status" })
    expect(request.patterns).toEqual(["git status"])
    expect(request.metadata.command).toBe("git status")
  })
  test("missing configuration defaults to selected Pi model", () => {
    expect(loadPiConfig("/nonexistent/pi-reviewer-config.json").model).toBe("")
  })
  test("uses shared decision gates", () => {
    expect(decidePiReview(verdict, config()).kind).toBe("allow")
    expect(decidePiReview(verdict.replace('"low"', '"critical"'), config()).kind).not.toBe("allow")
    expect(decidePiReview("not JSON", config()).kind).toBe("escalate")
  })
  test("allows a valid completed review", async () => {
    const run = harness(async () => ({
      stopReason: "stop",
      content: [{ type: "text", text: verdict }],
    }))
    expect(await run()).toBeUndefined()
    expect(run.entries).toHaveLength(1)
    expect(run.entries[0]).toMatchObject({
      customType: "permission-reviewer.result",
      data: {
        outcome: "allow",
        toolName: "read",
        risk: "low",
        confidence: 0.99,
        reason: expect.any(String),
      },
    })
  })
  test("forwards tool-result text and image blocks to a vision reviewer", async () => {
    const image = { type: "image", data: "aGVsbG8=", mimeType: "image/png" }
    let sent: { messages: Array<{ content: Array<Record<string, unknown>> }> } | undefined
    const run = harness(async () => ({}), {
      model: { id: "vision", input: ["text", "image"] },
      sessionManager: {
        getSessionId: () => "session",
        getBranch: () => [
          {
            type: "message",
            id: "result",
            message: {
              role: "toolResult",
              toolName: "read",
              toolCallId: "previous",
              isError: false,
              content: [{ type: "text", text: "Screenshot evidence" }, image],
            },
          },
        ],
      },
      modelRegistry: {
        complete: async (_model: unknown, context: NonNullable<typeof sent>) => {
          sent = context
          return { stopReason: "stop", content: [{ type: "text", text: verdict }] }
        },
      },
    })
    expect(await run()).toBeUndefined()
    const content = sent!.messages[0]!.content
    expect(content).toContainEqual(image)
    expect(content[0]?.text).toContain("Screenshot evidence")
    expect(content[0]?.text).toContain("role=toolResult")
    expect(content[0]?.text).not.toContain(image.data)
  })
  test("displays fail-closed errors in the transcript", async () => {
    const run = harness(
      async () => ({}),
      {},
      () => {
        throw new Error("broken config")
      },
    )
    expect(await run()).toMatchObject({ block: true })
    expect(run.entries).toHaveLength(1)
    expect(run.entries[0]?.data).toMatchObject({
      outcome: "deny",
      reason: "Permission reviewer failed: broken config",
      source: "failure-safe",
    })
  })
  test("commands switch escalation between manual approval and denial with reasoning", async () => {
    let approvals = 0
    const run = harness(
      async () => ({ stopReason: "stop", content: [{ type: "text", text: "bad JSON" }] }),
      {
        hasUI: true,
        ui: {
          confirm: async () => {
            approvals++
            return true
          },
        },
      },
    )
    await run.command("manual")
    expect(await run()).toBeUndefined()
    expect(run.entries.at(-1)?.data.mode).toBe("manual")
    expect(approvals).toBe(1)
    await run.command("deny")
    expect(await run()).toMatchObject({
      block: true,
      reason: expect.stringContaining("Reviewer returned invalid output"),
    })
    expect(run.entries.at(-1)?.data.mode).toBe("deny")
    expect(approvals).toBe(1)
    await run.command("manual")
    await run.command("reset")
    expect(await run()).toMatchObject({ block: true })
    expect(approvals).toBe(1)
  })
  test("manual mode does not override explicit reviewer denials", async () => {
    let approvals = 0
    const run = harness(
      async () => ({
        stopReason: "stop",
        content: [{ type: "text", text: verdict.replace('"allow"', '"deny"') }],
      }),
      {
        hasUI: true,
        ui: {
          confirm: async () => {
            approvals++
            return true
          },
        },
      },
    )
    await run.command("manual")
    expect(await run()).toMatchObject({ block: true })
    expect(approvals).toBe(0)
  })
  test("blocks reviewer errors", async () => {
    expect(
      await harness(async () => {
        throw new Error("offline")
      })(),
    ).toMatchObject({ block: true })
  })
  test("blocks invalid and truncated output", async () => {
    for (const [stopReason, text] of [
      ["stop", "bad JSON"],
      ["length", verdict],
    ]) {
      expect(
        await harness(async () => ({ stopReason, content: [{ type: "text", text }] }))(),
      ).toMatchObject({ block: true })
    }
  })
  test("times out even when the provider ignores cancellation", async () => {
    const run = harness(
      () => new Promise(() => {}),
      {},
      () => ({ ...config(), timeoutMs: 5 }),
    )
    expect(await run()).toMatchObject({ block: true })
  })
  test("manual escalation requires an available UI and affirmative approval", async () => {
    const complete = async () => ({
      stopReason: "stop",
      content: [{ type: "text", text: "invalid" }],
    })
    const manual = () => ({ ...config(), escalationMode: "manual" as const })
    expect(await harness(complete, {}, manual)()).toMatchObject({ block: true })
    expect(
      await harness(complete, { hasUI: true, ui: { confirm: async () => false } }, manual)(),
    ).toMatchObject({ block: true })
    expect(
      await harness(complete, { hasUI: true, ui: { confirm: async () => true } }, manual)(),
    ).toBeUndefined()
  })
  test("configuration failures block calls", async () => {
    expect(
      await harness(
        async () => ({}),
        {},
        () => {
          throw new Error("bad configuration")
        },
      )(),
    ).toMatchObject({ block: true })
  })
  test("blocks cancelled calls before invoking the reviewer", async () => {
    let called = false
    const run = harness(
      async () => {
        called = true
      },
      { signal: AbortSignal.abort() },
    )
    expect(await run()).toMatchObject({ block: true })
    expect(called).toBe(false)
  })
})
