import { describe, expect, test } from "bun:test"
import { widgetLines } from "./pi-ui-helpers.ts"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
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
  const listeners = new Map<string, (payload: unknown) => void>()
  const entries: Array<{ customType: string; data: Record<string, unknown> }> = []
  registerPiReviewer(
    {
      events: {
        on: (name: string, listener: (payload: unknown) => void) => listeners.set(name, listener),
      },
      registerEntryRenderer: () => {},
      registerTool: () => {},
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
    model: { id: "test", input: ["text"], reasoning: true },
    sessionManager: { getSessionId: () => "session", getBranch: () => [] },
    modelRegistry: { complete },
    ...overrides,
  } as unknown as ExtensionContext
  const registry = ctx.modelRegistry as unknown as {
    complete: (...args: unknown[]) => Promise<unknown>
    streamSimple: (...args: unknown[]) => { result: () => Promise<unknown> }
  }
  registry.streamSimple = (...args) => ({
    result: () => registry.complete(...args),
    async *[Symbol.asyncIterator]() {
      yield { type: "start" }
    },
  })
  return Object.assign(
    () => handler({ toolCallId: "call", toolName: "read", input: { path: "README.md" } }, ctx),
    {
      entries,
      emit: (name: string, payload: unknown) => listeners.get(name)?.(payload),
      tool: (toolName: string, input: Record<string, unknown>) =>
        handler({ toolCallId: "call", toolName, input }, ctx),
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
  test("inspects local scripts without executing them and confines evidence to the workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-script-inspection-"))
    const workspace = join(root, "workspace")
    const outside = join(root, "outside")
    try {
      await mkdir(workspace)
      await mkdir(outside)
      await mkdir(join(workspace, "scripts"))
      const marker = join(workspace, "executed")
      const script = `from pathlib import Path\nPath(${JSON.stringify(marker)}).touch()\nprint("INSPECTED_SCRIPT")\n`
      await writeFile(join(workspace, "scripts/task.py"), script)
      await writeFile(join(outside, "private.py"), 'print("OUTSIDE_SECRET")')
      let evidence = ""
      const run = harness(async () => ({}), {
        cwd: workspace,
        modelRegistry: {
          complete: async (
            _model: unknown,
            context: { messages: Array<{ content: Array<{ text?: string }> }> },
          ) => {
            evidence = context.messages[0]!.content[0]!.text!
            return { stopReason: "stop", content: [{ type: "text", text: verdict }] }
          },
        },
      })
      expect(await run.tool("bash", { command: "cd scripts && python3 task.py" })).toBeUndefined()
      expect(evidence).toContain("LOCAL_SCRIPT_ANALYSIS")
      expect(evidence).toContain("INSPECTED_SCRIPT")
      expect(evidence).not.toContain("sk-proj-abcdefghijklmnopqrstuvwxyz1234567890")
      expect(await Bun.file(marker).exists()).toBe(false)
      await writeFile(
        join(workspace, "scripts/task.py"),
        script + "# token=sk-proj-abcdefghijklmnopqrstuvwxyz1234567890\n",
      )
      expect(await run.tool("bash", { command: "python3 scripts/task.py" })).toBeUndefined()
      expect(evidence).toContain("possible literal credential or private key")
      expect(evidence).not.toContain("sk-proj-abcdefghijklmnopqrstuvwxyz1234567890")
      expect(
        await run.tool("bash", { command: `cd ${outside} && python3 private.py` }),
      ).toBeUndefined()
      expect(evidence).toContain("outside approved enrichment roots")
      expect(evidence).not.toContain("OUTSIDE_SECRET")
      expect(await run.tool("bash", { command: "python3 missing.py" })).toBeUndefined()
      expect(evidence).toContain("LOCAL_SCRIPT_ANALYSIS")
      expect(evidence).toContain("missing")
      expect(await run.tool("bash", { command: 'python3 -c "print(1)"' })).toBeUndefined()
      expect(evidence).not.toContain("\nLOCAL_SCRIPT_ANALYSIS\n")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  test("SSH evidence reaches reviewer; missing executable stdin is rejected before review", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-ssh-"))
    try {
      await writeFile(join(root, "script.py"), 'print("SSH_STDIN_EVIDENCE")')
      let evidence = ""
      let calls = 0
      const run = harness(async () => ({}), {
        cwd: root,
        modelRegistry: {
          complete: async (
            _model: unknown,
            context: { messages: Array<{ content: Array<{ text?: string }> }> },
          ) => {
            calls++
            evidence = context.messages[0]!.content[0]!.text!
            return { stopReason: "stop", content: [{ type: "text", text: verdict }] }
          },
        },
      })
      expect(
        await run.tool("bash", { command: "cat script.py | ssh -p 2222 user@host python3 -" }),
      ).toBeUndefined()
      expect(evidence).toContain("SSH_ANALYSIS")
      expect(evidence).toContain("SSH_STDIN_EVIDENCE")
      expect(evidence).toContain("2222")
      expect(
        await run.tool("bash", { command: "cat absent.py | ssh user@host python3 -" }),
      ).toMatchObject({ block: true })
      expect(calls).toBe(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  test("Git evidence describes pre-command state without staging planned targets", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-git-"))
    try {
      expect(Bun.spawnSync(["git", "init", "-b", "review-test", root]).exitCode).toBe(0)
      await writeFile(join(root, "planned.txt"), "not staged yet\n")
      let evidence = ""
      const run = harness(async () => ({}), {
        cwd: root,
        modelRegistry: {
          complete: async (
            _model: unknown,
            context: { messages: Array<{ content: Array<{ text?: string }> }> },
          ) => {
            evidence = context.messages[0]!.content[0]!.text!
            return { stopReason: "stop", content: [{ type: "text", text: verdict }] }
          },
        },
      })
      expect(await run.tool("bash", { command: "git add planned.txt" })).toBeUndefined()
      expect(evidence).toContain("GIT_STATE_ANALYSIS")
      expect(evidence).toContain("review-test")
      expect(evidence).toContain("planned.txt")
      expect(
        Bun.spawnSync(["git", "-C", root, "diff", "--cached", "--name-only"]).stdout.toString(),
      ).toBe("")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
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
  test("retries malformed output once with corrective instructions", async () => {
    let calls = 0
    let retryPrompt = ""
    const run = harness(async () => ({}), {
      modelRegistry: {
        complete: async (
          _model: unknown,
          context: { messages: Array<{ content: Array<{ text?: string }> }> },
        ) => {
          calls++
          retryPrompt = context.messages[0]!.content.map((part) => part.text ?? "").join("\n")
          return {
            stopReason: "stop",
            content: [{ type: "text", text: calls === 1 ? "Draft: " + verdict : verdict }],
          }
        },
      },
    })
    expect(await run()).toBeUndefined()
    expect(calls).toBe(2)
    expect(retryPrompt).toContain("previous response was not a valid decision")
  })
  test("does not retry valid denials or valid escalations", async () => {
    for (const outcome of ["deny", "escalate"]) {
      let calls = 0
      const run = harness(async () => {
        calls++
        return {
          stopReason: "stop",
          content: [{ type: "text", text: verdict.replace('"allow"', JSON.stringify(outcome)) }],
        }
      })
      expect(await run()).toMatchObject({ block: true })
      expect(calls).toBe(1)
    }
  })
  test("invalid output retry is bounded to two attempts", async () => {
    let calls = 0
    const run = harness(async () => {
      calls++
      return { stopReason: "stop", content: [{ type: "text", text: "invalid" }] }
    })
    expect(await run()).toMatchObject({ block: true })
    expect(calls).toBe(2)
  })
  test("reasoning controls reach provider-neutral requests, including corrective retries", async () => {
    const options: Array<Record<string, unknown>> = []
    const run = harness(
      async () => ({}),
      {
        modelRegistry: {
          complete: async (_model: unknown, _context: unknown, opts: Record<string, unknown>) => {
            options.push(opts)
            return {
              stopReason: "stop",
              content: [{ type: "text", text: options.length === 1 ? "invalid" : verdict }],
              usage: {
                input: 100,
                output: 20,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 120,
                reasoning: 5,
              },
            }
          },
        },
      },
      () => ({ ...config(), variant: "high" }),
    )
    expect(await run()).toBeUndefined()
    expect(options).toHaveLength(2)
    expect(options[0]?.reasoning).toBe("high")
    expect(options[1]?.reasoning).toBe("high")
    expect(run.entries.at(-1)?.data.usage).toMatchObject({
      input: 200,
      output: 40,
      totalTokens: 240,
      reasoning: 10,
      attempts: 2,
      reportedAttempts: 2,
    })
  })
  test("live progress shows evidence and retry phases and clears on completion or failure", async () => {
    for (const fail of [false, true]) {
      const frames: Array<string[] | undefined> = []
      let calls = 0
      const run = harness(
        async () => {
          if (fail) throw new Error("offline")
          calls++
          return {
            stopReason: "stop",
            content: [{ type: "text", text: calls === 1 ? "invalid" : verdict }],
          }
        },
        {
          mode: "tui",
          ui: { setWidget: (_key: string, content: unknown) => frames.push(widgetLines(content)) },
        },
      )
      await run()
      const text = frames.flatMap((lines) => lines ?? []).join("\n")
      expect(text).toContain("Collecting conversation evidence")
      expect(text).toContain("Waiting for reviewer")
      if (!fail) expect(text).toContain("Retrying malformed decision")
      expect(frames.at(-1)).toBeUndefined()
    }
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
