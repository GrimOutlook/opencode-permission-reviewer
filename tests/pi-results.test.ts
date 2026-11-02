import { expect, test } from "bun:test"
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
  )
  result.risk = "low"
  result.confidence = 0.95
  const component = renderer(
    { data: result } as Parameters<typeof renderer>[0],
    {} as Parameters<typeof renderer>[1],
    { fg: (_color: string, text: string) => text } as Parameters<typeof renderer>[2],
  )!
  const wide = component.render(100).join("\n")
  expect(wide).toContain("Permission reviewer: ALLOW")
  expect(wide).toContain("risk: low")
  expect(wide).toContain("confidence: 95%")
  expect(wide).toContain("Explicitly requested")
  for (const line of component.render(20)) expect(visibleWidth(line)).toBeLessThanOrEqual(20)
})
