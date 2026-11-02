import { stripVTControlCharacters } from "node:util"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { grayReviewPanel } from "./panel.ts"
import { redactSecrets } from "../redact.ts"
import type { EscalationMode, ReviewExecutionResult } from "../types.ts"
import { formatReviewUsage, type PiReviewUsage } from "./usage.ts"

export type PiResultWithUsage = ReviewExecutionResult & { usage?: PiReviewUsage }

export const PI_REVIEW_RESULT = "permission-reviewer.result"

export interface PiReviewResult {
  toolName: string
  toolCallId: string
  outcome: "allow" | "deny"
  reason: string
  durationMs: number
  source: string
  mode?: EscalationMode
  risk?: string
  confidence?: number
  usage?: PiReviewUsage
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
  result: PiResultWithUsage,
  durationMs: number,
  mode?: EscalationMode,
): PiReviewResult {
  return {
    toolName: displayText(toolName),
    toolCallId,
    outcome: result.kind === "allow" ? "allow" : "deny",
    reason: displayText(result.reason),
    durationMs,
    ...(mode ? { mode } : {}),
    ...(result.usage ? { usage: result.usage } : {}),
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
    const outcome =
      result.outcome === "allow"
        ? `ALLOW (${result.source === "manual-superseded" ? "human-approved" : "automatic"})`
        : "DENY"
    const escalation = result.mode === "manual" ? "ask" : (result.mode ?? "unknown")
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
    return grayReviewPanel(
      [
        theme.fg(
          color,
          `Permission reviewer: ${outcome} [on escalation: ${escalation}] — ${displayText(result.toolName)}`,
        ),
        theme.fg("muted", summary),
        theme.fg("muted", formatReviewUsage(result.usage)),
        displayText(result.reason),
      ].join("\n"),
      theme,
    )
  })
}

/** Display-only session entries never enter the model context or start a turn. */
export function publishResult(
  pi: ExtensionAPI,
  toolName: string,
  toolCallId: string,
  result: PiResultWithUsage,
  durationMs: number,
  mode?: EscalationMode,
): void {
  pi.appendEntry(
    PI_REVIEW_RESULT,
    reviewResultEntry(toolName, toolCallId, result, durationMs, mode),
  )
}
