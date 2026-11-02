import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import { stripVTControlCharacters } from "node:util"

export const PI_REVIEW_PROGRESS = "permission-reviewer.progress"
export type ReviewProgress = (phase: string) => void

/** Transient UI only: never store evidence, model text, or reasoning in the panel. */
export function startReviewProgress(
  ctx: ExtensionContext,
  toolName: string,
): { update: ReviewProgress; stop: () => void } {
  if (ctx.mode !== "tui") return { update: () => {}, stop: () => {} }
  let phase = "Starting review"
  let stopped = false
  let frame = 0
  const started = performance.now()
  const tool = stripVTControlCharacters(toolName).replace(/\s+/g, " ").slice(0, 100)
  const draw = () => {
    if (stopped) return
    const spinner = ["|", "/", "-", "\\"][frame++ % 4]
    ctx.ui.setWidget(
      PI_REVIEW_PROGRESS,
      [
        `${spinner} Permission reviewer — ${tool} — ${((performance.now() - started) / 1000).toFixed(1)}s`,
        phase,
      ],
      { placement: "aboveEditor" },
    )
  }
  draw()
  const timer = setInterval(draw, 250)
  return {
    update: (next) => {
      if (!stopped) {
        phase = next
        draw()
      }
    },
    stop: () => {
      if (stopped) return
      stopped = true
      clearInterval(timer)
      ctx.ui.setWidget(PI_REVIEW_PROGRESS, undefined)
    },
  }
}

/** Consume activity events without exposing private reasoning or partial verdicts. */
export async function observeReviewStream<T>(
  stream: AsyncIterable<{ type: string }> & { result(): Promise<T> },
  progress: ReviewProgress,
): Promise<T> {
  let lastPhase = ""
  for await (const event of stream) {
    const phase = event.type.startsWith("thinking_")
      ? "Reviewer is reasoning"
      : event.type.startsWith("text_")
        ? "Receiving reviewer decision"
        : undefined
    if (phase && phase !== lastPhase) {
      lastPhase = phase
      progress(phase)
    }
  }
  return stream.result()
}
