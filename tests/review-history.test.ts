import { describe, expect, test } from "bun:test"
import { HISTORY_LIMIT, ReviewHistory, reviewAppearance } from "../src/review-history.ts"
import { createUiStatus } from "../src/ui-protocol.ts"
import { request } from "./helpers.ts"

function status(
  phase: "reviewing" | "approved" | "denied" | "manual",
  id = "per_1",
  sessionID = "ses_main",
  at = 100,
) {
  return createUiStatus(request({ id, sessionID }), phase, {
    model: "test/model",
    variant: "high",
    timeoutMs: 60_000,
    emittedAt: at,
    reason: "A narrow requested action.",
  })
}

describe("review history", () => {
  test("fail-closed disposition remains visible after the permission rejection", () => {
    const history = new ReviewHistory()
    history.observe({ ...status("denied"), escalationDisposition: "deny" })
    history.replied("ses_main", "per_1", "reject")
    expect(reviewAppearance(history.forSession("ses_main")[0]!).title).toBe(
      "✕ Blocked (fail-closed)",
    )
  })

  test("updates one request, keeps separate permissions for a shared tool, and sorts newest first", () => {
    const history = new ReviewHistory()
    history.observe(status("reviewing"))
    history.observe(status("approved", "per_1", "ses_main", 101))
    history.observe(status("denied", "per_2", "ses_main", 102))
    history.observe(status("reviewing", "per_1", "ses_main", 99))
    expect(history.forSession("ses_main").map((entry) => entry.status.phase)).toEqual([
      "denied",
      "approved",
    ])
  })

  test("persists decisions but not unacknowledged in-flight reviews", () => {
    const history = new ReviewHistory()
    history.observe(status("reviewing", "pending"))
    history.observe(status("approved", "approved"))
    history.observe(status("manual", "manual"))
    const restored = new ReviewHistory()
    restored.restore(JSON.parse(JSON.stringify(history.snapshot())))
    expect(
      restored
        .forSession("ses_main")
        .map((entry) => entry.status.requestID)
        .sort(),
    ).toEqual(["approved", "manual"])
  })

  test("manual replies are retained and late reviewer decisions cannot override them", () => {
    const history = new ReviewHistory()
    history.observe(status("reviewing"))
    history.replied("ses_main", "per_1", "reject")
    history.observe(status("approved", "per_1", "ses_main", 102))
    const restored = new ReviewHistory()
    restored.restore(history.snapshot())
    expect(reviewAppearance(restored.forSession("ses_main")[0]!).title).toBe("✕ Permission denied")
    expect(restored.forSession("ses_main")[0]!.status.phase).toBe("reviewing")
    expect(restored.forSession("ses_main")[0]!.reply).toBe("reject")
  })

  test("manual grants and automatic review results have distinct labels", () => {
    const history = new ReviewHistory()
    history.observe(status("manual"))
    history.replied("ses_main", "per_1", "always")
    expect(reviewAppearance(history.forSession("ses_main")[0]!).title).toBe("✓ Permission allowed")
    history.observe(status("approved", "per_2"))
    expect(
      reviewAppearance(
        history.forSession("ses_main").find((entry) => entry.status.requestID === "per_2")!,
      ).title,
    ).toBe("✓ Reviewer approved")
  })

  test("saved ancestor IDs include subagent history without leaking unrelated sessions", () => {
    const history = new ReviewHistory()
    history.observe(status("approved", "per_child", "ses_child"), ["ses_parent", "ses_main"])
    history.observe(status("denied", "per_other", "ses_other"))
    const restored = new ReviewHistory()
    restored.restore(history.snapshot())
    expect(restored.forSession("ses_main").map((entry) => entry.status.sessionID)).toEqual([
      "ses_child",
    ])
    expect(restored.forSession("ses_parent")).toHaveLength(1)
    expect(restored.forSession("ses_child")).toHaveLength(1)
    expect(restored.forSession("ses_unrelated")).toHaveLength(0)
  })

  test("bounds storage and redacts persisted commands and rationales", () => {
    const history = new ReviewHistory()
    for (let index = 0; index <= HISTORY_LIMIT; index++) {
      history.observe(status("approved", `per_${index}`, "ses_main", index))
    }
    expect(history.snapshot().entries).toHaveLength(HISTORY_LIMIT)
    expect(history.forSession("ses_main").some((entry) => entry.status.requestID === "per_0")).toBe(
      false,
    )
    history.observe({
      ...status("approved", "secret", "ses_main", 1000),
      action: "$ run TOKEN=abcdefghijklmnop",
      reason: "Bearer abcdefghijklmnop",
    })
    const saved = JSON.stringify(history.snapshot())
    expect(saved).not.toContain("abcdefghijklmnop")
    expect(saved).toContain("REDACTED")
  })

  test("KV hydration preserves events that have already arrived and ignores malformed records", () => {
    const history = new ReviewHistory()
    history.observe(status("approved"))
    history.restore({ version: 1, entries: [{ status: status("denied") }, null, { status: {} }] })
    expect(history.forSession("ses_main")[0]!.status.phase).toBe("approved")
    expect(history.forSession("ses_main")).toHaveLength(1)
    history.restore({ version: 2, entries: [{ status: status("denied") }] })
    expect(history.forSession("ses_main")).toHaveLength(1)
  })
})
