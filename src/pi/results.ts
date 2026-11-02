import { stripVTControlCharacters } from "node:util"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Text } from "@earendil-works/pi-tui"
import { redactSecrets } from "../redact.ts"
import type { ReviewExecutionResult } from "../types.ts"

export const PI_REVIEW_RESULT = "permission-reviewer.result"

export interface PiReviewResult {
  toolName: string
  toolCallId: string
  outcome: "allow" | "deny"
  reason: string
  durationMs: number
  source: string
  risk?: string
  confidence?: number
}

function displayText(text: string): string {
  // Results are untrusted model/tool text, not terminal control sequences.
  return Array.from(stripVTControlCharacters(redactSecrets(text)))
    .filter((character) => {
      const code = character.codePointAt(0)!
      return code === 9 || code === 10 || (code >= 32 && !(code >= 127 && code <= 159))
    })
    .join("")
}

export function reviewResultEntry(
  toolName: string,
  toolCallId: string,
  result: ReviewExecutionResult,
  durationMs: number,
): PiReviewResult {
  return {
    toolName: displayText(toolName),
    toolCallId,
    outcome: result.kind === "allow" ? "allow" : "deny",
    reason: displayText(result.reason),
    durationMs,
    source: result.decisionSource ?? "failure-safe",
    ...(result.decision
      ? { risk: result.decision.risk_level, confidence: result.decision.confidence }
      : {}),
  }
}

export function registerResultRenderer(pi: ExtensionAPI): void {
  pi.registerEntryRenderer<PiReviewResult>(PI_REVIEW_RESULT, (entry, _options, theme) => {
    const result = entry.data
    if (!result) return undefined
    const color = result.outcome === "allow" ? "success" : "error"
    const summary = [
      result.risk ? `risk: ${result.risk}` : undefined,
      result.confidence === undefined
        ? undefined
        : `confidence: ${Math.round(result.confidence * 100)}%`,
      `${(result.durationMs / 1000).toFixed(1)}s`,
      result.source,
    ]
      .filter(Boolean)
      .join(" · ")
    return new Text(
      [
        theme.fg(
          color,
          `Permission reviewer: ${result.outcome.toUpperCase()} — ${displayText(result.toolName)}`,
        ),
        theme.fg("muted", summary),
        displayText(result.reason),
      ].join("\n"),
      1,
      1,
    )
  })
}

/** Display-only session entries never enter the model context or start a turn. */
export function publishResult(
  pi: ExtensionAPI,
  toolName: string,
  toolCallId: string,
  result: ReviewExecutionResult,
  durationMs: number,
): void {
  pi.appendEntry(PI_REVIEW_RESULT, reviewResultEntry(toolName, toolCallId, result, durationMs))
}
