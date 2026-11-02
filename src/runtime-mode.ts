import type { ReviewerConfig } from "./types.ts"

export type ReviewMode = "automatic" | "human-review"
export const MODE_COMMAND = "opencode-permission-reviewer.mode."

export function currentReviewMode(config: ReviewerConfig): ReviewMode {
  return config.mode ?? (config.escalationMode === "deny" ? "automatic" : "human-review")
}

/** Handles only the dedicated UI control channel, never chat/tool content. */
export function applyModeCommand(config: ReviewerConfig, event: unknown): string | undefined {
  if (!event || typeof event !== "object") return
  const value = event as { type?: unknown; properties?: { command?: unknown } }
  if (value.type !== "tui.command.execute") return
  const command = value.properties?.command
  if (typeof command !== "string" || !command.startsWith(MODE_COMMAND)) return
  const action = command.slice(MODE_COMMAND.length)
  if (action === "get") return `${MODE_COMMAND}state.${currentReviewMode(config)}`
  if (action !== "toggle" && action !== "automatic" && action !== "human-review") return
  const mode =
    action === "toggle"
      ? currentReviewMode(config) === "automatic"
        ? "human-review"
        : "automatic"
      : action
  config.mode = mode
  config.escalationMode = mode === "automatic" ? "deny" : "manual"
  return `${MODE_COMMAND}changed.${mode}`
}
