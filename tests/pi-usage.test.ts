import { expect, test } from "bun:test"
import { ReviewUsage, formatReviewUsage } from "../src/pi/usage.ts"

test("token counts aggregate retries, caches and reasoning without double-counting", () => {
  const usage = new ReviewUsage()
  for (let i = 0; i < 2; i++) {
    usage.startAttempt()
    usage.add({
      input: 100,
      output: 20,
      cacheRead: 30,
      cacheWrite: 10,
      totalTokens: 160,
      reasoning: 5,
    })
  }
  expect(usage.snapshot()).toEqual({
    input: 200,
    output: 40,
    cacheRead: 60,
    cacheWrite: 20,
    totalTokens: 320,
    reasoning: 10,
    attempts: 2,
    reportedAttempts: 2,
  })
  const text = formatReviewUsage(usage.snapshot())
  expect(text).toContain("320 total")
  expect(text).toContain("10 reasoning, included in output")
  expect(text).toContain("across 2 attempts")
})

test("no call, missing usage, and partially reported attempts are distinguished", () => {
  const usage = new ReviewUsage()
  expect(formatReviewUsage(usage.snapshot())).toContain("0 (no model call)")
  usage.startAttempt()
  usage.add(undefined)
  expect(formatReviewUsage(usage.snapshot())).toContain("unavailable")
  usage.startAttempt()
  usage.add({ input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120 })
  expect(formatReviewUsage(usage.snapshot())).toContain("partial usage")
  const snapshot = usage.snapshot()
  snapshot.input = 0
  expect(usage.snapshot().input).toBe(100)
})
