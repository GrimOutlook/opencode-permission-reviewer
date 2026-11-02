import { expect, test } from "bun:test"
import { testReviewTheme } from "./pi-ui-helpers.ts"
import type { EntryRenderer, ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { visibleWidth } from "@earendil-works/pi-tui"
import {
  PI_REVIEW_RESULT,
  registerResultRenderer,
  reviewResultEntry,
  type PiReviewResult,
} from "../src/pi/results.ts"

test("result entries redact secrets and remove terminal controls", () => {
  const result = reviewResultEntry(
    "bash\u001b[31m",
    "call",
    {
      kind: "deny",
      reason: "Blocked\u001b[2J\u0007 token=sk-proj-abcdefghijklmnopqrstuvwxyz1234567890",
    },
    123,
  )
  expect(result.toolName).toBe("bash")
  expect(result.reason).not.toContain("\u001b")
  expect(result.reason).not.toContain("\u0007")
  expect(result.reason).not.toContain("sk-proj-abcdefghijklmnopqrstuvwxyz1234567890")
})

test("renderer shows outcome, risk, confidence, and reason at narrow widths", () => {
  let renderer!: EntryRenderer<PiReviewResult>
  registerResultRenderer({
    registerEntryRenderer: (name: string, fn: typeof renderer) => {
      expect(name).toBe(PI_REVIEW_RESULT)
      renderer = fn
    },
  } as unknown as ExtensionAPI)
  const result = reviewResultEntry(
    "read",
    "call",
    { kind: "allow", reason: "Explicitly requested", decisionSource: "llm-reviewer" },
    1500,
    "manual",
  )
  result.risk = "low"
  result.confidence = 0.95
  result.usage = {
    input: 100,
    output: 20,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 120,
    attempts: 1,
    reportedAttempts: 1,
  }
  const component = renderer(
    { data: result } as Parameters<typeof renderer>[0],
    {} as Parameters<typeof renderer>[1],
    testReviewTheme,
  )!
  const wide = component.render(100).join("\n")
  expect(wide).toContain("Permission reviewer: ALLOW (automatic) [on escalation: ask]")
  expect(wide).toContain("risk: low")
  expect(wide).toContain("confidence: 95%")
  expect(wide).toContain("Explicitly requested")
  expect(wide).toContain("tokens: 120 total (100 in / 20 out)")
  for (const line of component.render(20)) expect(visibleWidth(line)).toBeLessThanOrEqual(20)
  result.source = "manual-superseded"
  const human = renderer(
    { data: result } as Parameters<typeof renderer>[0],
    {} as Parameters<typeof renderer>[1],
    testReviewTheme,
  )!
  expect(human.render(120).join("\n")).toContain("ALLOW (human-approved) [on escalation: ask]")
  result.outcome = "deny"
  result.mode = "deny"
  const denied = renderer(
    { data: result } as Parameters<typeof renderer>[0],
    {} as Parameters<typeof renderer>[1],
    testReviewTheme,
  )!
  expect(denied.render(120).join("\n")).toContain("DENY [on escalation: deny]")
})
