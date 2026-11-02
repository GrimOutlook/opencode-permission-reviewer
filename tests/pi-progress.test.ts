import { expect, test } from "bun:test"
import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import { startReviewProgress, observeReviewStream, PI_REVIEW_PROGRESS } from "../src/pi/progress.ts"

test("live panel updates phases and elapsed time, then clears and ignores late updates", async () => {
  const frames: Array<string[] | undefined> = []
  const ctx = {
    mode: "tui",
    ui: {
      setWidget: (key: string, lines: string[] | undefined) => {
        expect(key).toBe(PI_REVIEW_PROGRESS)
        frames.push(lines)
      },
    },
  } as unknown as ExtensionContext
  const live = startReviewProgress(ctx, "bash")
  try {
    expect(frames[0]?.join("\n")).toContain("Starting review")
    live.update("Inspecting Git state")
    expect(frames.at(-1)?.join("\n")).toContain("Inspecting Git state")
    const count = frames.length
    await new Promise((resolve) => setTimeout(resolve, 280))
    expect(frames.length).toBeGreaterThan(count)
    expect(frames.at(-1)?.[0]).toContain("Permission reviewer — bash")
  } finally {
    live.stop()
  }
  expect(frames.at(-1)).toBeUndefined()
  const count = frames.length
  live.update("Late provider event")
  live.stop()
  expect(frames).toHaveLength(count)
})

test("print and RPC modes never create a terminal widget", () => {
  for (const mode of ["print", "json", "rpc"]) {
    const live = startReviewProgress({ mode } as ExtensionContext, "read")
    live.update("Reviewing")
    live.stop()
  }
})

test("stream activity is visible without exposing private reasoning or partial verdicts", async () => {
  const phases: string[] = []
  const stream = {
    async *[Symbol.asyncIterator]() {
      yield { type: "thinking_delta", delta: "PRIVATE_REASONING" }
      yield { type: "thinking_delta", delta: "more private text" }
      yield { type: "text_delta", delta: "PARTIAL_VERDICT" }
      yield { type: "done" }
    },
    result: async () => "final result",
  }
  expect(await observeReviewStream(stream, (phase) => phases.push(phase))).toBe("final result")
  expect(phases).toEqual(["Reviewer is reasoning", "Receiving reviewer decision"])
  expect(phases.join()).not.toContain("PRIVATE_REASONING")
  expect(phases.join()).not.toContain("PARTIAL_VERDICT")
})
